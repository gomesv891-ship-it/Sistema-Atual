import { getStoredRendimentos, RendimentoItem } from './rendimentosService';

export interface ColaPackageOption {
  id: string;
  name: string;
  yieldM2: number;
  weightKg?: number | null;
}

export interface ColaPackageAllocation {
  id: string;
  name: string;
  yieldM2: number;
  quantity: number;
  coverageM2: number;
}

export interface ColaOptimizationResult {
  allocations: ColaPackageAllocation[];
  totalCoverageM2: number;
  wasteM2: number;
  totalPackages: number;
}

const SCALE = 10000;
const MAX_SEARCH_STEPS = 2500000;

function toScaled(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  return Math.round(val * SCALE);
}

function fromScaled(scaled: number): number {
  return Math.round(scaled) / SCALE;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

export function normalizeColaText(val?: string): string {
  return (val || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function extractPackageWeightKg(name?: string): number | null {
  const clean = normalizeColaText(name);
  if (!clean) return null;

  const kgMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*kg\b/i);
  if (kgMatch && kgMatch[1]) {
    const parsed = parseFloat(kgMatch[1].replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const parenMatch = clean.match(/\(\s*(\d+(?:[.,]\d+)?)\s*\)/);
  if (parenMatch && parenMatch[1]) {
    const parsed = parseFloat(parenMatch[1].replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return null;
}

function detectColaBrandLine(text: string): string | null {
  const n = normalizeColaText(text);
  if (n.includes('globalfix') || n.includes('global fix')) return 'globalfix';
  if (n.includes('tack permanente')) return 'tack_permanente';
  if (n.includes('super tack') || n.includes('supertack')) return 'super_tack';
  if (/\bultra\b/.test(n)) return 'ultra';
  if (n.includes('mapei')) return 'mapei';
  return null;
}

function isAreaYieldUnit(unit?: string): boolean {
  const u = normalizeColaText(unit).replace(/\s+/g, '');
  if (!u) return true;
  if (
    u.includes('caixa') ||
    u.includes('cx') ||
    u.includes('barra') ||
    u.includes('rolo') ||
    u.includes('bisnaga') ||
    u === 'kg/m2' ||
    u === 'kg/m²'
  ) {
    return false;
  }
  return (
    u.includes('m2') ||
    u.includes('m²') ||
    u.includes('balde') ||
    u.includes('unidade') ||
    u === 'un'
  );
}

/**
 * Extrai rendimento explícito em m² da descrição/detalhes/nome de um produto de cola,
 * sem confundir o peso em kg (ex: 18KG, 4KG, 3,6Kg) com rendimento.
 */
export function extractExplicitColaYieldFromText(text?: string): number | null {
  const raw = (text || '').trim();
  if (!raw) return null;

  // 1. "rendimento: 60" ou "rendimento de 60 m²"
  const rendMatch = raw.match(
    /rendimento\s*(?:de|:|=)?\s*(\d+(?:[.,]\d+)?)\s*(?:m[²2])?/i
  );
  if (rendMatch && rendMatch[1]) {
    const val = parseFloat(rendMatch[1].replace(',', '.'));
    if (Number.isFinite(val) && val > 0) return val;
  }

  // 2. "60 m²/balde", "60m²", "13 m2/un"
  const m2Match = raw.match(
    /(\d+(?:[.,]\d+)?)\s*m[²2](?:\s*\/\s*(?:balde|un|unidade|lata|gal[aã]o))?/i
  );
  if (m2Match && m2Match[1]) {
    const val = parseFloat(m2Match[1].replace(',', '.'));
    if (Number.isFinite(val) && val > 0) return val;
  }

  return null;
}

/**
 * Resolve o rendimento individual em m² por embalagem de um produto de cola,
 * priorizando:
 * 1) Cadastro de Rendimentos (`fenix_calculadora_rendimentos`)
 * 2) Especificação explícita na descrição/detalhes/nome do produto
 * 3) Rendimentos padrão Fênix World por linha/peso (quando aplicável)
 */
export function resolveColaProductYieldM2(
  product: { name: string; description?: string; details?: string },
  options?: {
    rendimentosOverride?: RendimentoItem[];
    defaultYield?: number | null;
  }
): number | null {
  const name = (product?.name || '').trim();
  if (!name) return options?.defaultYield ?? null;

  const pNorm = normalizeColaText(name);
  const pWeight = extractPackageWeightKg(name);
  const pBrand = detectColaBrandLine(name);

  // 1. Tabela de Rendimentos (ModalRendimentos / fenix_calculadora_rendimentos)
  try {
    const rendimentos = options?.rendimentosOverride ?? getStoredRendimentos();
    let bestScore = -1;
    let bestYield: number | null = null;

    for (const r of rendimentos) {
      if (!r || !r.produto) continue;
      if (!isAreaYieldUnit(r.unidade)) continue;

      const rProd = normalizeColaText(r.produto);
      if (!rProd) continue;

      const rWeight = extractPackageWeightKg(r.produto);
      // Nunca associar embalagens de pesos diferentes (ex: 18 kg vs 4 kg)
      if (pWeight !== null && rWeight !== null && Math.abs(pWeight - rWeight) > 0.05) {
        continue;
      }

      const rBrand = detectColaBrandLine(r.produto);
      // Se o rendimento especifica uma marca diferente do produto, não aplicar
      if (rBrand && pBrand && rBrand !== pBrand) {
        continue;
      }
      if (rBrand && !pBrand) {
        continue;
      }

      const isSpecialtyProduct =
        pBrand === 'globalfix' || pBrand === 'tack_permanente' || pBrand === 'mapei';

      let score = -1;
      if (rProd === pNorm) {
        score = 100;
      } else if (
        rProd.length >= 4 &&
        (!isSpecialtyProduct || rBrand === pBrand) &&
        (pNorm.includes(rProd) || rProd.includes(pNorm))
      ) {
        score = 80;
      } else if (
        pWeight !== null &&
        rWeight !== null &&
        Math.abs(pWeight - rWeight) <= 0.05 &&
        (!isSpecialtyProduct || rBrand === pBrand) &&
        (rProd.includes('cola') ||
          rProd.includes('adesivo') ||
          (rBrand !== null && rBrand === pBrand))
      ) {
        // Ex: "Cola 18 kg" ou "Cola 4 kg" cadastrado na tabela de Rendimentos
        score = rBrand ? 70 : 60;
      }

      if (score > bestScore) {
        const numMatch = String(r.rendimento || '').match(/(\d+(?:[.,]\d+)?)/);
        if (numMatch && numMatch[1]) {
          const parsed = parseFloat(numMatch[1].replace(',', '.'));
          if (Number.isFinite(parsed) && parsed > 0) {
            bestScore = score;
            bestYield = parsed;
          }
        }
      }
    }

    if (bestYield !== null) {
      return bestYield;
    }
  } catch {
    // fallback seguro fora do browser
  }

  // 2. Rendimento explícito em details / description / name
  const fromDetails = extractExplicitColaYieldFromText(product.details);
  if (fromDetails !== null) return fromDetails;

  const fromDescription = extractExplicitColaYieldFromText(product.description);
  if (fromDescription !== null) return fromDescription;

  const fromName = extractExplicitColaYieldFromText(name);
  if (fromName !== null) return fromName;

  // 3. Rendimentos padrão conhecidos por linha/marca antes do fallback genérico
  if (pBrand === 'globalfix') {
    if (pWeight !== null) {
      if (pWeight >= 19) return 75;
      if (Math.abs(pWeight - 3.6) <= 0.2 || Math.abs(pWeight - 4) <= 0.2) return 12;
    }
  }

  if (pBrand === 'tack_permanente') {
    if (pWeight !== null) {
      if (pWeight >= 19) return 75;
      if (Math.abs(pWeight - 3.6) <= 0.2 || Math.abs(pWeight - 4) <= 0.2) return 12;
    }
  }

  if (options?.defaultYield !== undefined) {
    return options.defaultYield;
  }

  if (pWeight !== null) {
    if (Math.abs(pWeight - 18) <= 0.2) return 60;
    if (Math.abs(pWeight - 4) <= 0.2) return 13;
    if (pWeight >= 20) return 75;
    if (Math.abs(pWeight - 3.6) <= 0.2) return 12;
  }

  return null;
}

/**
 * Otimiza a combinação de embalagens de qualquer conjunto de tamanhos/rendimentos
 * para atingir cobertura >= targetAreaM2 com:
 * 1. Menor sobra possível (coverage - targetAreaM2 >= 0)
 * 2. Em caso de empate na sobra, menor número total de embalagens
 * 3. Sem limitar a quantidade de embalagens ou ordem fixa, com aritmética escalada exata
 */
export function optimizePackageCombination(
  targetAreaM2: number,
  packages: ColaPackageOption[]
): ColaOptimizationResult {
  const areaScaled = toScaled(Number(targetAreaM2) || 0);
  if (areaScaled <= 0 || !Array.isArray(packages) || packages.length === 0) {
    return {
      allocations: (packages || []).map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        yieldM2: pkg.yieldM2,
        quantity: 0,
        coverageM2: 0,
      })),
      totalCoverageM2: 0,
      wasteM2: 0,
      totalPackages: 0,
    };
  }

  // Filtra pacotes com rendimento positivo e escala para inteiros exatos
  const validItems = packages
    .map((pkg, originalIndex) => ({
      pkg,
      originalIndex,
      yieldScaled: toScaled(Number(pkg.yieldM2) || 0),
    }))
    .filter((entry) => entry.yieldScaled > 0);

  if (validItems.length === 0) {
    return {
      allocations: packages.map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        yieldM2: pkg.yieldM2,
        quantity: 0,
        coverageM2: 0,
      })),
      totalCoverageM2: 0,
      wasteM2: 0,
      totalPackages: 0,
    };
  }

  // Deduplica rendimentos exatamente iguais mantendo o primeiro representante
  const uniqueByYieldMap = new Map<number, (typeof validItems)[0]>();
  for (const item of validItems) {
    if (!uniqueByYieldMap.has(item.yieldScaled)) {
      uniqueByYieldMap.set(item.yieldScaled, item);
    }
  }

  // Ordena internamente do maior rendimento para o menor
  const sorted = Array.from(uniqueByYieldMap.values()).sort(
    (a, b) => b.yieldScaled - a.yieldScaled
  );

  const k = sorted.length;
  const yields = sorted.map((s) => s.yieldScaled);

  let bestWasteScaled = Infinity;
  let bestTotalPacks = Infinity;
  let bestCounts = new Array<number>(k).fill(0);

  const isPreferableTie = (cand: number[], currentBest: number[]): boolean => {
    // Em empate exato de sobra E quantidade total de embalagens, desempate determinístico
    for (let i = 0; i < k; i++) {
      if (cand[i] !== currentBest[i]) {
        return cand[i] > currentBest[i];
      }
    }
    return false;
  };

  const evaluateCandidate = (counts: number[], coverageScaled: number, totalPacks: number) => {
    if (coverageScaled < areaScaled || totalPacks <= 0) return;
    const wasteScaled = coverageScaled - areaScaled;

    if (wasteScaled < bestWasteScaled) {
      bestWasteScaled = wasteScaled;
      bestTotalPacks = totalPacks;
      bestCounts = [...counts];
    } else if (wasteScaled === bestWasteScaled) {
      if (totalPacks < bestTotalPacks) {
        bestTotalPacks = totalPacks;
        bestCounts = [...counts];
      } else if (totalPacks === bestTotalPacks && isPreferableTie(counts, bestCounts)) {
        bestCounts = [...counts];
      }
    }
  };

  // Inicializa limite superior avaliando cada embalagem individualmente
  for (let i = 0; i < k; i++) {
    const q = Math.floor((areaScaled + yields[i] - 1) / yields[i]);
    const singleCounts = new Array<number>(k).fill(0);
    singleCounts[i] = q;
    evaluateCandidate(singleCounts, q * yields[i], q);
  }

  if (k > 1) {
    const y0 = yields[0];
    // Para qualquer i >= 1 com yields[i] < y0:
    // Se q_i >= y0 / gcd(y0, y_i), trocar c_i unidades de y_i por c_0 unidades de y0
    // mantém exatamente a mesma cobertura e reduz o total de embalagens.
    // Logo nenhuma solução ótima possui q_i >= maxDistinctPerSmaller[i].
    const maxDistinct = yields.map((yi, i) =>
      i === 0 ? Infinity : Math.floor(y0 / gcd(y0, yi))
    );

    const currentCounts = new Array<number>(k).fill(0);
    let steps = 0;

    const search = (idx: number, coveredSmall: number, smallPacks: number) => {
      if (steps >= MAX_SEARCH_STEPS) return;
      steps++;

      if (coveredSmall >= areaScaled) {
        currentCounts[0] = 0;
        evaluateCandidate(currentCounts, coveredSmall, smallPacks);
        return;
      }

      if (idx === k) {
        const rem = areaScaled - coveredSmall;
        const q0 = Math.floor((rem + y0 - 1) / y0);
        currentCounts[0] = q0;
        evaluateCandidate(currentCounts, coveredSmall + q0 * y0, smallPacks + q0);
        currentCounts[0] = 0;
        return;
      }

      const rem = areaScaled - coveredSmall;
      // Poda: mesmo completando o restante só com y0, nunca venceria o melhor empate de sobra=0
      if (bestWasteScaled === 0) {
        const minAdditional = Math.floor((rem + y0 - 1) / y0);
        if (smallPacks + minAdditional > bestTotalPacks) {
          return;
        }
      }

      const yi = yields[idx];
      const maxByRem = Math.floor((rem + yi - 1) / yi);
      const upper = Math.min(maxDistinct[idx] - 1, maxByRem);

      for (let q = 0; q <= upper; q++) {
        if (steps >= MAX_SEARCH_STEPS) break;
        const nextCov = coveredSmall + q * yi;
        if (nextCov >= areaScaled) {
          // Já atingiu a metragem necessária usando q unidades de yi;
          // quantidades maiores de q ou de pacotes seguintes só aumentariam sobra e total de baldes.
          currentCounts[idx] = q;
          currentCounts[0] = 0;
          evaluateCandidate(currentCounts, nextCov, smallPacks + q);
          currentCounts[idx] = 0;
          break;
        }
        currentCounts[idx] = q;
        search(idx + 1, nextCov, smallPacks + q);
      }
      currentCounts[idx] = 0;
    };

    search(1, 0, 0);
  }

  // Mapeia as quantidades de volta para a lista original de embalagens
  const quantityByOriginalIndex = new Map<number, number>();
  let totalCovScaled = 0;
  let totalPacks = 0;

  for (let i = 0; i < k; i++) {
    const qty = bestCounts[i] || 0;
    quantityByOriginalIndex.set(sorted[i].originalIndex, qty);
    totalCovScaled += qty * yields[i];
    totalPacks += qty;
  }

  const allocations: ColaPackageAllocation[] = packages.map((pkg, idx) => {
    const qty = quantityByOriginalIndex.get(idx) || 0;
    const covScaled = qty * toScaled(Number(pkg.yieldM2) || 0);
    return {
      id: pkg.id,
      name: pkg.name,
      yieldM2: pkg.yieldM2,
      quantity: qty,
      coverageM2: fromScaled(covScaled),
    };
  });

  const totalCoverageM2 = fromScaled(totalCovScaled);
  const wasteM2 = Math.max(0, fromScaled(totalCovScaled - areaScaled));

  return {
    allocations,
    totalCoverageM2,
    wasteM2,
    totalPackages: totalPacks,
  };
}
