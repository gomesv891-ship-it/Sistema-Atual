import {
  DEFAULT_INDIVIDUAL_METAS,
  DEFAULT_METAS_CONFIG,
  IndividualMetasMap,
  MetasParametersConfig,
  calculateCurrentMetasDates,
  normalizeUserMetaKey,
} from './configOrcamentoEMetas';
import {
  getSupabaseClient,
  fetchSupabaseKeysIndividually,
  getLocalCollectionSafe,
  getLocalRawSafe,
  setLocalCollectionSafe,
} from './supabaseClient';
import {
  isBudgetProposalOfSeller,
  isRecordOfResponsible,
  resolveCanonicalProposalSeller,
} from './userDataFilter';

export type SimuladorPeriodoKey = 'hoje' | 'semana' | 'mes';

export type SimuladorEstrategiaKey =
  | 'menos_clientes'
  | 'equilibrada'
  | 'mais_oportunidades';

export interface SimuladorMetaPeriodo {
  key: SimuladorPeriodoKey;
  titulo: string;
  subtitulo: string;
  valorMeta: number;
  valorVendido: number;
  percentualProgresso: number;
  faltaVender: number;
}

export interface SimuladorClienteOrcamento {
  /** Identificador interno usado apenas para key de renderização e redirecionamento ao Follow-up */
  internalTargetId: string;
  /** Chave interna de agrupamento por cliente (garante no máximo 1 orçamento por cliente em cada estratégia) */
  clientGroupKey?: string;
  clientName: string;
  phone: string;
  budgetDateISO: string;
  budgetDateFormatted: string;
  valor: number;
}

export interface SimuladorEstrategiaResultado {
  key: SimuladorEstrategiaKey;
  titulo: string;
  descricao: string;
  faltaParaMeta: number;
  totalCombinacao: number;
  quantidadeClientes: number;
  clientes: SimuladorClienteOrcamento[];
  atingeMeta: boolean;
}

export interface SimuladorSupabasePayload {
  currentUserName: string;
  monthYearLabel: string;
  periodos: Record<SimuladorPeriodoKey, SimuladorMetaPeriodo>;
  orcamentosElegiveis: SimuladorClienteOrcamento[];
  lastSyncedAt: string;
  error?: string;
}

const SIMULADOR_KV_KEYS = [
  'fenix_individual_metas_map',
  'fenix_metas_config_data',
  'fenix_metas_sales_db',
  'fenix_deleted_vendas_ids',
  'fenix_followup_cards_v2',
  'fenix_orcamentos_history',
  'fenix_saved_orcamentos',
  'fenix_clients_db',
  'fenix_pos_vendas_db',
] as const;

const MOCK_SALE_IDS = new Set(['v_1', 'v_2', 'v_3', 'v_4', 'v_5', 'v_6']);
const MOCK_CLIENT_NAMES = new Set([
  'roberto silva residência',
  'roberto silveira',
  'carvalho materiais & design',
  'construtora almeida & silva',
  'marcos vinicius instalações',
  'studio arqdesign interiores',
  'eng. renato prado projetos',
  'carlos eduardo',
  'mariana silva',
  'cliente comercial',
]);

function parseKvPayload<T = any>(raw: unknown, fallback: T): T {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function parseBRL(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const str = String(raw).trim();
  if (!str) return 0;

  if (/^-?\d+(\.\d+)?$/.test(str)) {
    const n = parseFloat(str);
    return Number.isFinite(n) ? n : 0;
  }

  const cleaned = str.replace(/[^\d.,-]/g, '');
  if (!cleaned) return 0;

  if (cleaned.includes('.') && cleaned.includes(',')) {
    const n = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  if (cleaned.includes(',')) {
    const n = parseFloat(cleaned.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts.length > 1 && parts[parts.length - 1].length === 3) {
      const n = parseFloat(cleaned.replace(/\./g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  const digits = cleaned.replace(/\D/g, '');
  const n = parseFloat(digits);
  return Number.isFinite(n) ? n : 0;
}

function formatPhoneDisplay(raw?: string | null): string {
  if (!raw) return '';
  const str = String(raw).trim();
  const digits = str.replace(/\D/g, '');
  if (digits.length < 8) return str;
  const localDigits =
    digits.length > 11 && digits.startsWith('55') ? digits.slice(2, 13) : digits.slice(0, 11);
  if (localDigits.length <= 2) return localDigits;
  if (localDigits.length <= 6) return `(${localDigits.slice(0, 2)}) ${localDigits.slice(2)}`;
  if (localDigits.length <= 10) {
    return `(${localDigits.slice(0, 2)}) ${localDigits.slice(2, 6)}-${localDigits.slice(6)}`;
  }
  return `(${localDigits.slice(0, 2)}) ${localDigits.slice(2, 7)}-${localDigits.slice(7, 11)}`;
}

function parseDateParts(raw?: string | null): { year: number; month: number; day: number } | null {
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str) return null;

  if (/^\d{10,13}$/.test(str)) {
    const ms = str.length === 10 ? Number(str) * 1000 : Number(str);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
    }
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const d = new Date(str);
    if (!Number.isNaN(d.getTime())) {
      return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
    }
  }

  const dateOnly = str.split('T')[0].split(' ')[0];

  if (dateOnly.includes('-')) {
    const parts = dateOnly.split('-');
    if (parts.length >= 3) {
      if (parts[0].length === 4) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(day)) {
          return { year: y, month: m, day };
        }
      } else if (parts[2].length === 4) {
        const day = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const y = parseInt(parts[2], 10);
        if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(day)) {
          return { year: y, month: m, day };
        }
      }
    }
  }

  if (dateOnly.includes('/')) {
    const parts = dateOnly.split('/');
    if (parts.length >= 3) {
      if (parts[2].length === 4) {
        const day = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const y = parseInt(parts[2], 10);
        if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(day)) {
          return { year: y, month: m, day };
        }
      } else if (parts[0].length === 4) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(day)) {
          return { year: y, month: m, day };
        }
      }
    }
  }

  return null;
}

function formatDateBR(raw?: string | null): string {
  const parts = parseDateParts(raw);
  if (!parts) return 'Data não informada';
  const dd = String(parts.day).padStart(2, '0');
  const mm = String(parts.month + 1).padStart(2, '0');
  return `${dd}/${mm}/${parts.year}`;
}

function toISOYYYYMMDD(raw?: string | null): string {
  const parts = parseDateParts(raw);
  if (!parts) return '';
  return `${parts.year}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getWeekOfMonthMondaySplit(year: number, monthZero: number, day: number): number {
  let weekCounter = 1;
  for (let d = 1; d <= day; d++) {
    const dt = new Date(year, monthZero, d);
    if (dt.getDay() === 1 && d > 1) {
      weekCounter++;
    }
  }
  return weekCounter;
}

function isDateInTargetMonth(dateStr: string | undefined, targetMonth: number, targetYear: number, allowEmpty = false): boolean {
  if (!dateStr) return allowEmpty;
  const p = parseDateParts(dateStr);
  if (!p) return allowEmpty;
  return p.year === targetYear && p.month === targetMonth;
}

function isDateToday(dateStr: string | undefined, refNow: Date): boolean {
  const p = parseDateParts(dateStr);
  if (!p) return false;
  return (
    p.year === refNow.getFullYear() &&
    p.month === refNow.getMonth() &&
    p.day === refNow.getDate()
  );
}

function isDateInTargetWeek(dateStr: string | undefined, refDate: Date): boolean {
  const p = parseDateParts(dateStr);
  if (!p) return false;
  const targetYear = refDate.getFullYear();
  const targetMonth = refDate.getMonth();
  if (p.year !== targetYear || p.month !== targetMonth) return false;

  const refWeek = getWeekOfMonthMondaySplit(targetYear, targetMonth, refDate.getDate());
  const saleWeek = getWeekOfMonthMondaySplit(p.year, p.month, p.day);
  return refWeek === saleWeek;
}

function isMockOrFictitiousRecord(item: any): boolean {
  if (!item) return true;
  const id = String(item.id || '').trim();
  if (MOCK_SALE_IDS.has(id)) return true;
  const rawName = String(item.cliente || item.clientName || item.clienteNome || '').toLowerCase().trim();
  if (!rawName) return false;
  if (MOCK_CLIENT_NAMES.has(rawName)) return true;
  if (rawName.includes('roberto silveira')) return true;
  return false;
}

function isStatusSold(status?: string | null): boolean {
  if (!status) return false;
  const s = String(status).toLowerCase().trim();
  return (
    s === 'vendido' ||
    s === 'fechado' ||
    s === 'fechados' ||
    s === 'concluído' ||
    s === 'concluido' ||
    s === 'aprovado' ||
    s === 'ganho'
  );
}

function isStatusLost(status?: string | null): boolean {
  if (!status) return false;
  const s = String(status).toLowerCase().trim();
  return (
    s === 'perdido' ||
    s === 'perdidos' ||
    s === 'rejeitado' ||
    s === 'recusado' ||
    s === 'desistiu' ||
    s === 'cancelado' ||
    s === 'cancelada' ||
    s === 'não vendido' ||
    s === 'nao vendido'
  );
}

function isBudgetStatusEligible(status?: string | null, trackingStatus?: string | null): boolean {
  if (isStatusSold(status) || isStatusLost(status)) return false;
  if (trackingStatus && (isStatusSold(trackingStatus) || isStatusLost(trackingStatus))) return false;
  return true;
}

function getSaleProductValue(sale: { valor?: unknown; frete?: unknown }): number {
  if (!sale) return 0;
  const total = parseBRL(sale.valor);
  const frete = parseBRL(sale.frete);
  if (frete > 0) {
    return Math.max(0, total - frete);
  }
  return Math.max(0, total);
}

function normalizeBareOrcId(raw?: string | null): string {
  if (!raw) return '';
  return String(raw).trim().replace(/^fup_/, '').replace(/^orc_/, '');
}

function extractFallbackTimestampDate(idStr?: string | null): string {
  if (!idStr) return '';
  const match = String(idStr).match(/(\d{13})/);
  if (match) {
    const ms = Number(match[1]);
    if (!Number.isNaN(ms) && ms > 1500000000000) {
      return new Date(ms).toISOString();
    }
  }
  return '';
}

function sanitizeClientDisplayName(raw?: string | null): string {
  const cleaned = String(raw || '').trim();
  if (!cleaned) return 'Cliente';
  // Garante que tags internas iniciadas por # (ex: #Hubik) não vazem na exibição
  const withoutHashTags = cleaned.replace(/#[\w-]+/g, '').replace(/\s{2,}/g, ' ').trim();
  return withoutHashTags || cleaned;
}

function normalizeClientNameKey(raw?: string | null): string {
  return sanitizeClientDisplayName(raw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhoneGroupKey(raw?: string | null): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 8) return '';
  return digits.length > 11 && digits.startsWith('55')
    ? digits.slice(2, 13)
    : digits.slice(-11);
}

function resolveUserMonthlyMeta(
  currentUserName: string,
  individualMap: Partial<IndividualMetasMap>,
  metasConfig: Partial<MetasParametersConfig>
): number {
  const key = normalizeUserMetaKey(currentUserName);
  const defaultMap: Record<string, number> = {
    vanessa: DEFAULT_INDIVIDUAL_METAS.vanessa,
    jhessica: DEFAULT_INDIVIDUAL_METAS.jhessica,
    eder: DEFAULT_INDIVIDUAL_METAS.eder,
    jeferson: DEFAULT_INDIVIDUAL_METAS.jeferson,
  };

  if (key && key !== 'todos') {
    const fromSupabase = (individualMap as Record<string, unknown>)[key];
    if (typeof fromSupabase === 'number' && fromSupabase > 0) {
      return fromSupabase;
    }
    if (defaultMap[key]) {
      return defaultMap[key];
    }
  }

  if (typeof metasConfig.metaValor === 'number' && metasConfig.metaValor > 0) {
    return metasConfig.metaValor;
  }

  return DEFAULT_METAS_CONFIG.metaValor;
}

/**
 * Consulta diretamente o Supabase (única fonte oficial de dados do simulador, sem localStorage)
 * e calcula metas, vendas reais e carteira de orçamentos elegíveis do mês selecionado
 * isolados exclusivamente para o usuário logado.
 */
export async function fetchSimuladorDataFromSupabase(
  currentUserName: string,
  selectedDate: Date
): Promise<SimuladorSupabasePayload> {
  const targetMonth = selectedDate.getMonth();
  const targetYear = selectedDate.getFullYear();

  const now = new Date();
  const isCurrentMonth =
    targetYear === now.getFullYear() && targetMonth === now.getMonth();
  const refDate = isCurrentMonth ? now : selectedDate;

  const client = getSupabaseClient();
  const emptyDates = calculateCurrentMetasDates(DEFAULT_METAS_CONFIG, refDate);

  const emptyResponse = (error?: string): SimuladorSupabasePayload => ({
    currentUserName,
    monthYearLabel: emptyDates.monthYearLabel,
    periodos: {
      hoje: {
        key: 'hoje',
        titulo: 'Venda de Hoje',
        subtitulo: 'Meta diária',
        valorMeta: 0,
        valorVendido: 0,
        percentualProgresso: 0,
        faltaVender: 0,
      },
      semana: {
        key: 'semana',
        titulo: 'Venda da Semana',
        subtitulo: 'Meta semanal',
        valorMeta: 0,
        valorVendido: 0,
        percentualProgresso: 0,
        faltaVender: 0,
      },
      mes: {
        key: 'mes',
        titulo: 'Meta do Mês',
        subtitulo: emptyDates.monthYearLabel,
        valorMeta: 0,
        valorVendido: 0,
        percentualProgresso: 0,
        faltaVender: 0,
      },
    },
    orcamentosElegiveis: [],
    lastSyncedAt: new Date().toISOString(),
    error,
  });

  if (!currentUserName || !currentUserName.trim()) {
    return emptyResponse('Usuário não identificado.');
  }

  if (!client) {
    return emptyResponse('Conexão com Supabase indisponível no momento.');
  }

  try {
    const { rows, succeededKeys } = await fetchSupabaseKeysIndividually([...SIMULADOR_KV_KEYS], 15000);

    const kvMap = new Map<string, any>();
    for (const key of SIMULADOR_KV_KEYS) {
      if (succeededKeys.has(key) && rows.has(key)) {
        const val = rows.get(key);
        kvMap.set(key, val);
        if (val !== undefined) {
          setLocalCollectionSafe(key, val);
        }
      } else {
        // Fallback seguro ao cache em memória / localStorage caso esta chave tenha sofrido instabilidade de rede
        const rawFallback = getLocalRawSafe(key);
        if (rawFallback) {
          try {
            kvMap.set(key, JSON.parse(rawFallback));
          } catch {
            kvMap.set(key, rawFallback);
          }
        } else {
          const listFallback = getLocalCollectionSafe(key, []);
          if (listFallback.length > 0) {
            kvMap.set(key, listFallback);
          }
        }
      }
    }

    if (succeededKeys.size === 0 && kvMap.size === 0) {
      throw new Error('Não foi possível consultar o Supabase no momento.');
    }

    const individualMetas = parseKvPayload<Partial<IndividualMetasMap>>(
      kvMap.get('fenix_individual_metas_map'),
      {}
    );
    const metasConfig = {
      ...DEFAULT_METAS_CONFIG,
      ...parseKvPayload<Partial<MetasParametersConfig>>(
        kvMap.get('fenix_metas_config_data'),
        {}
      ),
    };

    const metasDates = calculateCurrentMetasDates(metasConfig, refDate);
    const metaMensal = resolveUserMonthlyMeta(currentUserName, individualMetas, metasConfig);

    const deletedRaw = parseKvPayload<any[]>(kvMap.get('fenix_deleted_vendas_ids'), []);
    const deletedSet = new Set<string>(
      Array.isArray(deletedRaw) ? deletedRaw.map((x) => String(x).trim()) : []
    );

    const metasSalesRaw = parseKvPayload<any[]>(kvMap.get('fenix_metas_sales_db'), []);
    const followUpRaw = parseKvPayload<any[]>(kvMap.get('fenix_followup_cards_v2'), []);
    const orcHistoryRaw = parseKvPayload<any[]>(kvMap.get('fenix_orcamentos_history'), []);
    const orcSavedRaw = parseKvPayload<any[]>(kvMap.get('fenix_saved_orcamentos'), []);
    const clientsRaw = parseKvPayload<any[]>(kvMap.get('fenix_clients_db'), []);
    const posVendasRaw = parseKvPayload<any[]>(kvMap.get('fenix_pos_vendas_db'), []);

    // Mapa de telefones por clientId e nome para fallback seguro
    const phoneByClientId = new Map<string, string>();
    const phoneByClientName = new Map<string, string>();
    if (Array.isArray(clientsRaw)) {
      clientsRaw.forEach((c: any) => {
        if (!c) return;
        const phone = String(c.whatsapp || c.telefone || c.phone || '').trim();
        if (!phone) return;
        if (c.id) phoneByClientId.set(String(c.id).trim(), phone);
        if (c.name) phoneByClientName.set(String(c.name).trim().toLowerCase(), phone);
      });
    }

    const resolveClientPhone = (rec: any, linkedOrc?: any): string => {
      const candidates = [
        rec?.telefone,
        rec?.whatsapp,
        rec?.clientContact,
        rec?.contato,
        linkedOrc?.clientContact,
        linkedOrc?.telefone,
        linkedOrc?.whatsapp,
      ];
      for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length >= 8) {
          return formatPhoneDisplay(c);
        }
      }
      const cId = String(rec?.clientId || rec?.clienteId || linkedOrc?.clientId || '').trim();
      if (cId && phoneByClientId.has(cId)) {
        return formatPhoneDisplay(phoneByClientId.get(cId));
      }
      const cName = String(
        rec?.cliente || rec?.clientName || rec?.clienteNome || linkedOrc?.clientName || ''
      )
        .trim()
        .toLowerCase();
      if (cName && phoneByClientName.has(cName)) {
        return formatPhoneDisplay(phoneByClientName.get(cName));
      }
      return '';
    };

    // 1. Consolidação de vendas reais do usuário (sem mock, sem duplicidade, sem localStorage)
    const salesMap = new Map<string, any>();
    const seenSaleKeys = new Set<string>();
    const soldBareIds = new Set<string>();
    const soldFupIds = new Set<string>();

    const trackSaleKeys = (id: string, fupId: string, orcId: string, dedupKey: string) => {
      if (id) seenSaleKeys.add(id);
      if (fupId) {
        seenSaleKeys.add(fupId);
        seenSaleKeys.add(`v_orc_${fupId}`);
        soldFupIds.add(fupId);
      }
      if (orcId) {
        const bareOrc = normalizeBareOrcId(orcId);
        seenSaleKeys.add(orcId);
        seenSaleKeys.add(`fup_${orcId}`);
        seenSaleKeys.add(`v_orc_${orcId}`);
        seenSaleKeys.add(`v_orc_fup_${orcId}`);
        if (bareOrc) {
          soldBareIds.add(bareOrc);
          seenSaleKeys.add(bareOrc);
          seenSaleKeys.add(`orc_${bareOrc}`);
          seenSaleKeys.add(`fup_${bareOrc}`);
          seenSaleKeys.add(`fup_orc_${bareOrc}`);
          seenSaleKeys.add(`v_orc_${bareOrc}`);
          seenSaleKeys.add(`v_orc_orc_${bareOrc}`);
        }
      }
      if (dedupKey) seenSaleKeys.add(dedupKey);
    };

    // 1a. fenix_metas_sales_db
    if (Array.isArray(metasSalesRaw)) {
      metasSalesRaw.forEach((item: any, idx: number) => {
        if (!item || isMockOrFictitiousRecord(item)) return;
        const id = String(item.id || `v_${idx}`).trim();
        const cleanPed = item.pedido ? String(item.pedido).replace(/^#+/, '').trim() : '';
        const clientNorm = String(item.cliente || item.clientName || '').trim().toLowerCase();
        const fupId = item.followUpId ? String(item.followUpId).trim() : '';
        const orcId = item.orcamentoId ? String(item.orcamentoId).trim() : '';
        const bareOrc = normalizeBareOrcId(orcId || (fupId.startsWith('fup_') ? fupId : ''));
        const dedupKey = cleanPed && clientNorm ? `${cleanPed}_${clientNorm}` : '';

        if (
          deletedSet.has(id) ||
          (fupId && deletedSet.has(fupId)) ||
          (orcId && deletedSet.has(orcId)) ||
          (bareOrc && (deletedSet.has(bareOrc) || deletedSet.has(`v_orc_${bareOrc}`))) ||
          (cleanPed && (deletedSet.has(cleanPed) || deletedSet.has(`ped_${cleanPed}`)))
        ) {
          return;
        }

        const sameOrcOrFup =
          seenSaleKeys.has(id) ||
          (fupId && seenSaleKeys.has(fupId)) ||
          (orcId && seenSaleKeys.has(orcId)) ||
          (bareOrc && seenSaleKeys.has(bareOrc));
        const samePedClient = !orcId && Boolean(dedupKey && seenSaleKeys.has(dedupKey));
        if (sameOrcOrFup || samePedClient) return;

        trackSaleKeys(id, fupId, orcId, dedupKey);
        if (bareOrc) soldBareIds.add(bareOrc);
        if (fupId) soldFupIds.add(fupId);

        if (isRecordOfResponsible(item, currentUserName)) {
          salesMap.set(id, {
            id,
            valor: parseBRL(item.valor),
            frete: item.frete !== undefined ? parseBRL(item.frete) : 0,
            data: toISOYYYYMMDD(item.data || item.dataVenda || item.createdAt),
          });
        }
      });
    }

    // 1b. fenix_followup_cards_v2 com status 'Vendido'
    if (Array.isArray(followUpRaw)) {
      followUpRaw.forEach((fup: any) => {
        if (!fup || !fup.id) return;
        if (!isStatusSold(fup.status)) return;
        if (isMockOrFictitiousRecord(fup)) return;

        const fupId = String(fup.id).trim();
        const orcId = fup.orcamentoId ? String(fup.orcamentoId).trim() : fupId.replace(/^fup_/, '');
        const bareOrc = normalizeBareOrcId(orcId);
        const saleId = `v_orc_${orcId || fupId}`;
        const legacySaleId = `v_orc_${fupId}`;
        const cleanPed = fup.pedido ? String(fup.pedido).replace(/^#+/, '').trim() : '';
        const clientNorm = String(fup.cliente || fup.clientName || '').trim().toLowerCase();
        const dedupKey = cleanPed && clientNorm ? `${cleanPed}_${clientNorm}` : '';

        if (
          deletedSet.has(fupId) ||
          deletedSet.has(saleId) ||
          deletedSet.has(legacySaleId) ||
          (orcId && deletedSet.has(orcId)) ||
          (bareOrc && (deletedSet.has(bareOrc) || deletedSet.has(`v_orc_${bareOrc}`))) ||
          (cleanPed && deletedSet.has(cleanPed))
        ) {
          return;
        }

        if (bareOrc) soldBareIds.add(bareOrc);
        soldFupIds.add(fupId);

        if (
          seenSaleKeys.has(fupId) ||
          seenSaleKeys.has(saleId) ||
          seenSaleKeys.has(legacySaleId) ||
          (orcId && seenSaleKeys.has(orcId)) ||
          (bareOrc && (seenSaleKeys.has(bareOrc) || seenSaleKeys.has(`v_orc_${bareOrc}`))) ||
          (dedupKey && seenSaleKeys.has(dedupKey))
        ) {
          return;
        }

        trackSaleKeys(saleId, fupId, orcId, dedupKey);

        if (isRecordOfResponsible(fup, currentUserName)) {
          salesMap.set(saleId, {
            id: saleId,
            valor: parseBRL(fup.valor),
            frete: fup.frete !== undefined ? parseBRL(fup.frete) : 0,
            data: toISOYYYYMMDD(
              fup.dataVenda || fup.updatedAt || fup.dataAtualizacao || fup.dataCadastro || fup.dataCriacao
            ),
          });
        }
      });
    }

    // 1c. fenix_pos_vendas_db originadas de Metas (fallback resiliente)
    if (Array.isArray(posVendasRaw)) {
      posVendasRaw.forEach((p: any) => {
        if (!p) return;
        const isFromMetas =
          p.origem === 'metas' ||
          (p.id && String(p.id).startsWith('pv_meta_')) ||
          (p.notes && String(p.notes).includes('Metas'));
        if (!isFromMetas) return;
        if (isMockOrFictitiousRecord(p)) return;

        const rawId = String(p.id || '').trim();
        const saleId = rawId.replace(/^pv_meta_/, '');
        const cleanPed = p.orderNumber ? String(p.orderNumber).replace(/^#+/, '').trim() : '';
        const clientNorm = String(p.clientName || '').trim().toLowerCase();
        const dedupKey = cleanPed && clientNorm ? `${cleanPed}_${clientNorm}` : '';

        if (
          deletedSet.has(rawId) ||
          deletedSet.has(saleId) ||
          (cleanPed && (deletedSet.has(cleanPed) || deletedSet.has(`ped_${cleanPed}`)))
        ) {
          return;
        }

        if (
          seenSaleKeys.has(rawId) ||
          seenSaleKeys.has(saleId) ||
          (dedupKey && seenSaleKeys.has(dedupKey))
        ) {
          return;
        }

        trackSaleKeys(saleId, '', p.orcamentoId ? String(p.orcamentoId) : '', dedupKey);

        if (isRecordOfResponsible(p, currentUserName)) {
          salesMap.set(saleId, {
            id: saleId,
            valor: parseBRL(p.valor),
            frete: 0,
            data: toISOYYYYMMDD(p.completionDate || p.createdAt),
          });
        }
      });
    }

    // Filtra vendas exclusivamente do mês/ano selecionado e do usuário logado
    const userMonthSales = Array.from(salesMap.values()).filter((s) =>
      isDateInTargetMonth(s.data, targetMonth, targetYear, true)
    );

    const vendidoMes = userMonthSales.reduce((acc, s) => acc + getSaleProductValue(s), 0);
    const vendidoHoje = userMonthSales
      .filter((s) => isDateToday(s.data, now))
      .reduce((acc, s) => acc + getSaleProductValue(s), 0);
    const vendidoSemana = userMonthSales
      .filter((s) => isDateInTargetWeek(s.data, refDate))
      .reduce((acc, s) => acc + getSaleProductValue(s), 0);

    const faltaMes = Math.max(0, metaMensal - vendidoMes);

    const metaDiaria =
      metasDates.remainingWorkingDays > 0 && faltaMes > 0
        ? Math.round((faltaMes / metasDates.remainingWorkingDays) * 100) / 100
        : Math.round((metaMensal / Math.max(1, metasDates.totalWorkingDays || 22)) * 100) / 100;

    const metaSemanal =
      faltaMes > 0
        ? Math.round((faltaMes / Math.max(1, metasDates.semanasRestantes)) * 100) / 100
        : Math.round((metaMensal / Math.max(1, metasDates.semanasTotais || 4)) * 100) / 100;

    const faltaHoje = faltaMes <= 0 ? 0 : Math.max(0, metaDiaria - vendidoHoje);
    const faltaSemana = faltaMes <= 0 ? 0 : Math.max(0, metaSemanal - vendidoSemana);

    const pct = (sold: number, target: number) =>
      target > 0 ? Number(((sold / target) * 100).toFixed(1)) : 0;

    // 2. Extração rigorosa de TODOS os orçamentos elegíveis do mês selecionado (sem filtro por dia/semana)
    const orcByBareId = new Map<string, any>();
    [orcHistoryRaw, orcSavedRaw].forEach((collection) => {
      if (!Array.isArray(collection)) return;
      collection.forEach((orc: any) => {
        if (!orc || !orc.id) return;
        const bare = normalizeBareOrcId(orc.id);
        if (!bare) return;
        const existing = orcByBareId.get(bare);
        if (!existing) {
          orcByBareId.set(bare, orc);
        } else {
          const existingTs = new Date(existing.updatedAt || existing.savedAt || 0).getTime() || 0;
          const incomingTs = new Date(orc.updatedAt || orc.savedAt || 0).getTime() || 0;
          if (incomingTs >= existingTs) {
            orcByBareId.set(bare, { ...existing, ...orc });
          }
        }
      });
    });

    const eligibleBudgets: SimuladorClienteOrcamento[] = [];
    const budgetGroupMeta: Array<{ clientId: string; nameKey: string; phoneKey: string }> = [];
    const seenBareIds = new Set<string>();
    const seenRawIds = new Set<string>();

    const clientIdByPhoneKey = new Map<string, string>();
    const clientIdByUniqueNameKey = new Map<string, string>();
    const nameKeyDuplicates = new Set<string>();
    if (Array.isArray(clientsRaw)) {
      clientsRaw.forEach((c: any) => {
        if (!c || !c.id) return;
        const cId = String(c.id).trim();
        const pKey = normalizePhoneGroupKey(c.whatsapp || c.telefone || c.phone);
        if (pKey && !clientIdByPhoneKey.has(pKey)) {
          clientIdByPhoneKey.set(pKey, cId);
        }
        const nKey = normalizeClientNameKey(c.name);
        if (nKey && nKey !== 'cliente') {
          if (clientIdByUniqueNameKey.has(nKey)) {
            nameKeyDuplicates.add(nKey);
          } else {
            clientIdByUniqueNameKey.set(nKey, cId);
          }
        }
      });
      nameKeyDuplicates.forEach((nKey) => clientIdByUniqueNameKey.delete(nKey));
    }

    // 2a. Cards de Follow-up
    if (Array.isArray(followUpRaw)) {
      followUpRaw.forEach((it: any) => {
        if (!it || !it.id) return;
        const rawId = String(it.id).trim();
        if (isMockOrFictitiousRecord(it)) return;

        const bareOrc = normalizeBareOrcId(it.orcamentoId || (rawId.startsWith('fup_') ? rawId : ''));
        if ((bareOrc && seenBareIds.has(bareOrc)) || seenRawIds.has(rawId)) return;

        seenRawIds.add(rawId);
        if (it.orcamentoId) seenRawIds.add(String(it.orcamentoId).trim());
        if (bareOrc) seenBareIds.add(bareOrc);

        if (
          deletedSet.has(rawId) ||
          (bareOrc && (deletedSet.has(bareOrc) || deletedSet.has(`v_orc_${bareOrc}`)))
        ) {
          return;
        }

        const linkedOrc = bareOrc ? orcByBareId.get(bareOrc) : undefined;
        const isAlreadySold =
          soldFupIds.has(rawId) ||
          (bareOrc ? soldBareIds.has(bareOrc) : false) ||
          isStatusSold(it.status) ||
          isStatusSold(linkedOrc?.status) ||
          isStatusSold(it.trackingStatus);

        if (isAlreadySold) return;

        const effectiveStatus = it.status || linkedOrc?.status || 'Orçamento Enviado';
        if (!isBudgetStatusEligible(effectiveStatus, it.trackingStatus)) return;

        // Separação rigorosa por usuário logado (Vanessa vs Jhessica)
        const sellerCandidate = {
          consultoraName: it.consultoraName || linkedOrc?.consultoraName,
          responsavel: it.responsavel || linkedOrc?.responsavel,
          vendedor: it.vendedor || linkedOrc?.vendedor,
          criadoPor: it.criadoPor || linkedOrc?.criadoPor,
          registeredBy: it.registeredBy || linkedOrc?.registeredBy,
          vendedorId: it.vendedorId || linkedOrc?.vendedorId || null,
          responsavelId: it.responsavelId || linkedOrc?.responsavelId || null,
        };
        const { sellerName } = resolveCanonicalProposalSeller(sellerCandidate);
        if (!sellerName && !sellerCandidate.vendedorId && !sellerCandidate.responsavelId) return;
        if (!isBudgetProposalOfSeller(sellerCandidate, currentUserName)) return;

        const proposalDate =
          it.dataCriacao ||
          it.dataOrcamento ||
          linkedOrc?.dataOrcamento ||
          it.dataEntradaFollowUp ||
          it.createdAt ||
          linkedOrc?.savedAt ||
          linkedOrc?.createdAt ||
          it.dataCadastro ||
          it.data ||
          it.dataAtualizacao ||
          it.updatedAt ||
          extractFallbackTimestampDate(rawId) ||
          extractFallbackTimestampDate(linkedOrc?.id);

        if (!isDateInTargetMonth(proposalDate, targetMonth, targetYear, false)) return;

        const resolvedValue =
          parseBRL(it.valor) ||
          parseBRL(linkedOrc?.totalFinal) ||
          parseBRL(linkedOrc?.totalGeral) ||
          parseBRL(linkedOrc?.valor) ||
          0;
        if (resolvedValue <= 0) return;

        const clientName = sanitizeClientDisplayName(
          it.cliente || it.clientName || linkedOrc?.clientName
        );
        const phone = resolveClientPhone(it, linkedOrc);

        const rawClientId = String(
          it.clientId || it.clienteId || linkedOrc?.clientId || ''
        ).trim();
        const phoneKey = normalizePhoneGroupKey(phone);
        const nameKey = normalizeClientNameKey(clientName);
        const resolvedClientId =
          rawClientId ||
          (phoneKey ? clientIdByPhoneKey.get(phoneKey) || '' : '') ||
          (nameKey ? clientIdByUniqueNameKey.get(nameKey) || '' : '');

        eligibleBudgets.push({
          internalTargetId: rawId,
          clientName,
          phone,
          budgetDateISO: toISOYYYYMMDD(proposalDate),
          budgetDateFormatted: formatDateBR(proposalDate),
          valor: resolvedValue,
        });
        budgetGroupMeta.push({
          clientId: resolvedClientId,
          nameKey,
          phoneKey,
        });
      });
    }

    // 2b. Orçamentos complementares de histórico/salvos ainda não convertidos em Follow-up
    orcByBareId.forEach((orc, bareOrc) => {
      if (!orc || !orc.id) return;
      const orcId = String(orc.id).trim();
      const fupId = `fup_${orcId}`;
      if (seenBareIds.has(bareOrc) || seenRawIds.has(orcId) || seenRawIds.has(fupId)) return;
      if (isMockOrFictitiousRecord(orc)) return;

      seenBareIds.add(bareOrc);
      seenRawIds.add(orcId);

      if (
        deletedSet.has(orcId) ||
        deletedSet.has(bareOrc) ||
        deletedSet.has(`v_orc_${bareOrc}`)
      ) {
        return;
      }

      if (soldBareIds.has(bareOrc) || isStatusSold(orc.status)) return;
      if (!isBudgetStatusEligible(orc.status)) return;

      const sellerCandidate = {
        consultoraName: orc.consultoraName,
        responsavel: orc.responsavel,
        vendedor: orc.vendedor,
        criadoPor: orc.criadoPor,
        registeredBy: orc.registeredBy,
        vendedorId: orc.vendedorId || null,
        responsavelId: orc.responsavelId || null,
      };
      if (!isBudgetProposalOfSeller(sellerCandidate, currentUserName)) return;

      const proposalDate =
        orc.dataOrcamento ||
        orc.savedAt ||
        orc.createdAt ||
        orc.dataCriacao ||
        orc.data ||
        orc.updatedAt ||
        extractFallbackTimestampDate(orcId);

      if (!isDateInTargetMonth(proposalDate, targetMonth, targetYear, false)) return;

      const resolvedValue =
        parseBRL(orc.totalFinal) || parseBRL(orc.totalGeral) || parseBRL(orc.valor) || 0;
      if (resolvedValue <= 0) return;

      const clientName = sanitizeClientDisplayName(
        orc.clientName || orc.clienteNome || orc.cliente
      );
      const phone = resolveClientPhone(orc);

      const rawClientId = String(orc.clientId || orc.clienteId || '').trim();
      const phoneKey = normalizePhoneGroupKey(phone);
      const nameKey = normalizeClientNameKey(clientName);
      const resolvedClientId =
        rawClientId ||
        (phoneKey ? clientIdByPhoneKey.get(phoneKey) || '' : '') ||
        (nameKey ? clientIdByUniqueNameKey.get(nameKey) || '' : '');

      eligibleBudgets.push({
        internalTargetId: orc.followUpId ? String(orc.followUpId).trim() : orcId,
        clientName,
        phone,
        budgetDateISO: toISOYYYYMMDD(proposalDate),
        budgetDateFormatted: formatDateBR(proposalDate),
        valor: resolvedValue,
      });
      budgetGroupMeta.push({
        clientId: resolvedClientId,
        nameKey,
        phoneKey,
      });
    });

    // Agrupa os orçamentos pertencentes ao mesmo cliente (via ID, telefone ou nome normalizado)
    const nBudgets = eligibleBudgets.length;
    if (nBudgets > 0) {
      const parent = Array.from({ length: nBudgets }, (_, idx) => idx);
      const find = (x: number): number => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      };
      const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
      };

      for (let i = 0; i < nBudgets; i++) {
        for (let j = i + 1; j < nBudgets; j++) {
          const mi = budgetGroupMeta[i];
          const mj = budgetGroupMeta[j];
          const sameId = Boolean(mi.clientId && mj.clientId && mi.clientId === mj.clientId);
          const samePhone = Boolean(mi.phoneKey && mj.phoneKey && mi.phoneKey === mj.phoneKey);
          const differentIds = Boolean(
            mi.clientId && mj.clientId && mi.clientId !== mj.clientId
          );
          const differentPhones = Boolean(
            mi.phoneKey && mj.phoneKey && mi.phoneKey !== mj.phoneKey
          );
          const sameName = Boolean(
            mi.nameKey &&
              mj.nameKey &&
              mi.nameKey !== 'cliente' &&
              mi.nameKey === mj.nameKey &&
              !differentIds &&
              !differentPhones
          );

          if (sameId || samePhone || sameName) {
            union(i, j);
          }
        }
      }

      for (let i = 0; i < nBudgets; i++) {
        eligibleBudgets[i].clientGroupKey = `cg_${find(i)}`;
      }
    }

    return {
      currentUserName,
      monthYearLabel: metasDates.monthYearLabel,
      periodos: {
        hoje: {
          key: 'hoje',
          titulo: 'Venda de Hoje',
          subtitulo: 'Meta diária',
          valorMeta: metaDiaria,
          valorVendido: vendidoHoje,
          percentualProgresso: pct(vendidoHoje, metaDiaria),
          faltaVender: faltaHoje,
        },
        semana: {
          key: 'semana',
          titulo: 'Venda da Semana',
          subtitulo: `${metasDates.semanaAtual}ª semana de ${metasDates.monthName}`,
          valorMeta: metaSemanal,
          valorVendido: vendidoSemana,
          percentualProgresso: pct(vendidoSemana, metaSemanal),
          faltaVender: faltaSemana,
        },
        mes: {
          key: 'mes',
          titulo: 'Meta do Mês',
          subtitulo: metasDates.monthYearLabel,
          valorMeta: metaMensal,
          valorVendido: vendidoMes,
          percentualProgresso: pct(vendidoMes, metaMensal),
          faltaVender: faltaMes,
        },
      },
      orcamentosElegiveis: eligibleBudgets,
      lastSyncedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    return emptyResponse(
      err?.message || 'Não foi possível carregar os dados do Supabase.'
    );
  }
}

interface ClientBudgetGroup {
  key: string;
  optionsAsc: SimuladorClienteOrcamento[];
  minBudget: SimuladorClienteOrcamento;
  midBudget: SimuladorClienteOrcamento;
  maxBudget: SimuladorClienteOrcamento;
}

function groupBudgetsByClient(
  orcamentos: SimuladorClienteOrcamento[]
): ClientBudgetGroup[] {
  const valid = orcamentos.filter((o) => o.valor > 0);
  const n = valid.length;
  if (n === 0) return [];

  const meta = valid.map((item) => ({
    explicitKey: item.clientGroupKey || '',
    phoneKey: normalizePhoneGroupKey(item.phone),
    nameKey: normalizeClientNameKey(item.clientName),
  }));

  const parent = Array.from({ length: n }, (_, idx) => idx);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const mi = meta[i];
      const mj = meta[j];
      if (mi.explicitKey && mj.explicitKey) {
        if (mi.explicitKey === mj.explicitKey) union(i, j);
        continue;
      }
      const samePhone = Boolean(mi.phoneKey && mj.phoneKey && mi.phoneKey === mj.phoneKey);
      const differentPhones = Boolean(
        mi.phoneKey && mj.phoneKey && mi.phoneKey !== mj.phoneKey
      );
      const sameName = Boolean(
        mi.nameKey &&
          mj.nameKey &&
          mi.nameKey !== 'cliente' &&
          mi.nameKey === mj.nameKey &&
          !differentPhones
      );
      if (samePhone || sameName) {
        union(i, j);
      }
    }
  }

  const bucketMap = new Map<number, SimuladorClienteOrcamento[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!bucketMap.has(root)) bucketMap.set(root, []);
    bucketMap.get(root)!.push(valid[i]);
  }

  const groups: ClientBudgetGroup[] = [];
  bucketMap.forEach((items, root) => {
    const optionsAsc = [...items].sort((a, b) => {
      if (a.valor !== b.valor) return a.valor - b.valor;
      return b.budgetDateISO.localeCompare(a.budgetDateISO);
    });
    const minBudget = optionsAsc[0];
    const maxBudget = optionsAsc[optionsAsc.length - 1];
    const midBudget = optionsAsc[Math.floor(optionsAsc.length / 2)];
    groups.push({
      key: `client_${root}`,
      optionsAsc,
      minBudget,
      midBudget,
      maxBudget,
    });
  });

  return groups;
}

/**
 * MENOS CLIENTES:
 * - Considera apenas 1 orçamento por cliente.
 * - Busca atingir a meta com a menor quantidade possível de clientes.
 */
function pickMenosClientes(
  falta: number,
  groups: ClientBudgetGroup[]
): SimuladorClienteOrcamento[] {
  if (falta <= 0 || groups.length === 0) return [];

  // Se 1 único cliente já possui um orçamento >= falta, escolhe a menor opção >= falta (1 cliente, menor sobra)
  const singleClosingCandidates: SimuladorClienteOrcamento[] = [];
  for (const g of groups) {
    for (const opt of g.optionsAsc) {
      if (opt.valor >= falta) {
        singleClosingCandidates.push(opt);
      }
    }
  }
  if (singleClosingCandidates.length > 0) {
    singleClosingCandidates.sort((a, b) => {
      if (a.valor !== b.valor) return a.valor - b.valor;
      return b.budgetDateISO.localeCompare(a.budgetDateISO);
    });
    return [singleClosingCandidates[0]];
  }

  // Ordena clientes pelo maior orçamento individual disponível (garante o número mínimo de clientes)
  const sortedDesc = [...groups].sort((a, b) => {
    if (b.maxBudget.valor !== a.maxBudget.valor) {
      return b.maxBudget.valor - a.maxBudget.valor;
    }
    return b.maxBudget.budgetDateISO.localeCompare(a.maxBudget.budgetDateISO);
  });

  const prefixGroups: ClientBudgetGroup[] = [];
  let sum = 0;

  for (let i = 0; i < sortedDesc.length; i++) {
    const g = sortedDesc[i];
    const remainingNeeded = falta - sum;

    // Se algum cliente restante possui uma opção >= remainingNeeded, fecha no menor número de clientes com menor sobra no último cliente
    let bestCloser: { opt: SimuladorClienteOrcamento; groupIndex: number } | null = null;
    for (let j = i; j < sortedDesc.length; j++) {
      for (const opt of sortedDesc[j].optionsAsc) {
        if (opt.valor >= remainingNeeded) {
          if (
            !bestCloser ||
            opt.valor < bestCloser.opt.valor ||
            (opt.valor === bestCloser.opt.valor &&
              opt.budgetDateISO.localeCompare(bestCloser.opt.budgetDateISO) > 0)
          ) {
            bestCloser = { opt, groupIndex: j };
          }
        }
      }
    }

    if (bestCloser) {
      return [...prefixGroups.map((pg) => pg.maxBudget), bestCloser.opt].sort((a, b) => {
        if (b.valor !== a.valor) return b.valor - a.valor;
        return b.budgetDateISO.localeCompare(a.budgetDateISO);
      });
    }

    prefixGroups.push(g);
    sum += g.maxBudget.valor;
  }

  // Caso nem a soma dos maiores orçamentos de todos os clientes atinja a meta, retorna 1 (o maior) por cliente
  return prefixGroups.map((pg) => pg.maxBudget);
}

/**
 * MAIS OPORTUNIDADES:
 * - Considera apenas 1 orçamento por cliente.
 * - Busca distribuir a meta entre a maior quantidade possível de clientes.
 */
function pickMaisOportunidades(
  falta: number,
  groups: ClientBudgetGroup[]
): SimuladorClienteOrcamento[] {
  if (falta <= 0 || groups.length === 0) return [];

  const sortedAsc = [...groups].sort((a, b) => {
    if (a.minBudget.valor !== b.minBudget.valor) {
      return a.minBudget.valor - b.minBudget.valor;
    }
    return b.minBudget.budgetDateISO.localeCompare(a.minBudget.budgetDateISO);
  });

  const totalWithMins = sortedAsc.reduce((acc, g) => acc + g.minBudget.valor, 0);

  // Caso A: usando os menores orçamentos já atinge/ultrapassa a meta -> pega em ordem crescente (máximo de clientes)
  if (totalWithMins >= falta) {
    const selected: SimuladorClienteOrcamento[] = [];
    let sum = 0;
    for (const g of sortedAsc) {
      selected.push(g.minBudget);
      sum += g.minBudget.valor;
      if (sum >= falta) break;
    }
    return selected;
  }

  // Caso B: todos os clientes na opção mínima ainda ficam abaixo da meta ->
  // mantém TODOS os clientes (máximo de clientes) e promove gradativamente as opções de orçamento de clientes que têm alternativas maiores
  const chosenOptionIdx = sortedAsc.map(() => 0);
  let sum = totalWithMins;

  while (sum < falta) {
    const needed = falta - sum;
    let bestClosingUpgrade: { groupIdx: number; optIdx: number; delta: number } | null = null;
    let bestStepUpgrade: { groupIdx: number; optIdx: number; delta: number } | null = null;

    for (let i = 0; i < sortedAsc.length; i++) {
      const g = sortedAsc[i];
      const curIdx = chosenOptionIdx[i];
      const curVal = g.optionsAsc[curIdx].valor;

      for (let optIdx = curIdx + 1; optIdx < g.optionsAsc.length; optIdx++) {
        const delta = g.optionsAsc[optIdx].valor - curVal;
        if (delta <= 0) continue;

        if (delta >= needed) {
          if (!bestClosingUpgrade || delta < bestClosingUpgrade.delta) {
            bestClosingUpgrade = { groupIdx: i, optIdx, delta };
          }
        }

        if (optIdx === curIdx + 1) {
          if (!bestStepUpgrade || delta > bestStepUpgrade.delta) {
            bestStepUpgrade = { groupIdx: i, optIdx, delta };
          }
        }
      }
    }

    if (bestClosingUpgrade) {
      chosenOptionIdx[bestClosingUpgrade.groupIdx] = bestClosingUpgrade.optIdx;
      sum += bestClosingUpgrade.delta;
      break;
    }

    if (!bestStepUpgrade) break;
    chosenOptionIdx[bestStepUpgrade.groupIdx] = bestStepUpgrade.optIdx;
    sum += bestStepUpgrade.delta;
  }

  return sortedAsc
    .map((g, idx) => g.optionsAsc[chosenOptionIdx[idx]])
    .sort((a, b) => {
      if (a.valor !== b.valor) return a.valor - b.valor;
      return b.budgetDateISO.localeCompare(a.budgetDateISO);
    });
}

/**
 * EQUILIBRADA:
 * - Considera apenas 1 orçamento por cliente.
 * - Combina diferentes faixas de valor buscando equilíbrio entre valor e quantidade de clientes.
 */
function pickEquilibrada(
  falta: number,
  groups: ClientBudgetGroup[]
): SimuladorClienteOrcamento[] {
  if (falta <= 0 || groups.length === 0) return [];

  const sortedByMid = [...groups].sort((a, b) => {
    if (a.midBudget.valor !== b.midBudget.valor) {
      return a.midBudget.valor - b.midBudget.valor;
    }
    return b.midBudget.budgetDateISO.localeCompare(a.midBudget.budgetDateISO);
  });

  const n = sortedByMid.length;
  // Ordem balanceada partindo do centro (mediana) alternando faixas médias-altas e médias-baixás
  const balancedQueue: number[] = [];
  const mid = Math.floor(n / 2);
  let right = mid;
  let left = mid - 1;
  while (left >= 0 || right < n) {
    if (right < n) {
      balancedQueue.push(right);
      right++;
    }
    if (left >= 0) {
      balancedQueue.push(left);
      left--;
    }
  }

  const chosenOptionIdx = new Map<number, number>();
  const selectionOrder: number[] = [];
  let sum = 0;

  while (selectionOrder.length < n && sum < falta) {
    const needed = falta - sum;

    // Se já houver ao menos 1 cliente selecionado (ou só existe 1 cliente), busca ajuste fino (sobra <= 30%) entre clientes ainda não usados
    if (selectionOrder.length > 0 || n === 1) {
      let tightFit: { gIdx: number; optIdx: number; val: number } | null = null;
      for (const gIdx of balancedQueue) {
        if (chosenOptionIdx.has(gIdx)) continue;
        const g = sortedByMid[gIdx];
        for (let optIdx = 0; optIdx < g.optionsAsc.length; optIdx++) {
          const val = g.optionsAsc[optIdx].valor;
          if (val >= needed && val <= needed * 1.3) {
            if (!tightFit || val < tightFit.val) {
              tightFit = { gIdx, optIdx, val };
            }
          }
        }
      }
      if (tightFit) {
        chosenOptionIdx.set(tightFit.gIdx, tightFit.optIdx);
        selectionOrder.push(tightFit.gIdx);
        sum += tightFit.val;
        break;
      }
    }

    const nextIdx = balancedQueue.find((idx) => !chosenOptionIdx.has(idx));
    if (nextIdx === undefined) break;

    const g = sortedByMid[nextIdx];
    let optIdx = Math.floor(g.optionsAsc.length / 2);

    // Se a opção mediana exceder muito o que falta (> 130%) e o cliente possuir opção menor >= needed, usa a menor suficiente
    if (g.optionsAsc[optIdx].valor > needed * 1.3) {
      const smallerFittingIdx = g.optionsAsc.findIndex((o) => o.valor >= needed);
      if (smallerFittingIdx !== -1) {
        optIdx = smallerFittingIdx;
      }
    }

    chosenOptionIdx.set(nextIdx, optIdx);
    selectionOrder.push(nextIdx);
    sum += g.optionsAsc[optIdx].valor;
  }

  // Se todos os clientes já entraram com 1 opção mediana/menor e ainda falta para a meta, promove opções existentes antes de encerrar
  while (sum < falta) {
    const needed = falta - sum;
    let bestClosingUpgrade: { gIdx: number; optIdx: number; delta: number } | null = null;
    let bestStepUpgrade: { gIdx: number; optIdx: number; delta: number } | null = null;

    for (const gIdx of selectionOrder) {
      const g = sortedByMid[gIdx];
      const curIdx = chosenOptionIdx.get(gIdx) ?? 0;
      const curVal = g.optionsAsc[curIdx].valor;

      for (let optIdx = curIdx + 1; optIdx < g.optionsAsc.length; optIdx++) {
        const delta = g.optionsAsc[optIdx].valor - curVal;
        if (delta <= 0) continue;

        if (delta >= needed) {
          if (!bestClosingUpgrade || delta < bestClosingUpgrade.delta) {
            bestClosingUpgrade = { gIdx, optIdx, delta };
          }
        }

        if (optIdx === curIdx + 1) {
          if (!bestStepUpgrade || delta > bestStepUpgrade.delta) {
            bestStepUpgrade = { gIdx, optIdx, delta };
          }
        }
      }
    }

    if (bestClosingUpgrade) {
      chosenOptionIdx.set(bestClosingUpgrade.gIdx, bestClosingUpgrade.optIdx);
      sum += bestClosingUpgrade.delta;
      break;
    }

    if (!bestStepUpgrade) break;
    chosenOptionIdx.set(bestStepUpgrade.gIdx, bestStepUpgrade.optIdx);
    sum += bestStepUpgrade.delta;
  }

  return selectionOrder.map(
    (gIdx) => sortedByMid[gIdx].optionsAsc[chosenOptionIdx.get(gIdx) ?? 0]
  );
}

/**
 * Calcula as 3 estratégias de fechamento sobre o saldo restante do período selecionado,
 * utilizando exclusivamente os orçamentos elegíveis do mês inteiro e garantindo
 * NO MÁXIMO UM orçamento por cliente dentro de cada estratégia.
 */
export function calcularEstrategiasFechamento(
  faltaParaMeta: number,
  orcamentosElegiveisDoMes: SimuladorClienteOrcamento[]
): Record<SimuladorEstrategiaKey, SimuladorEstrategiaResultado> {
  const falta = Math.max(0, faltaParaMeta);
  const clientGroups = groupBudgetsByClient(orcamentosElegiveisDoMes);

  const buildResult = (
    key: SimuladorEstrategiaKey,
    titulo: string,
    descricao: string,
    selected: SimuladorClienteOrcamento[]
  ): SimuladorEstrategiaResultado => {
    const totalCombinacao = selected.reduce((acc, it) => acc + it.valor, 0);
    return {
      key,
      titulo,
      descricao,
      faltaParaMeta: falta,
      totalCombinacao,
      quantidadeClientes: selected.length,
      clientes: selected,
      atingeMeta: falta === 0 || totalCombinacao >= falta,
    };
  };

  const menosClientes = pickMenosClientes(falta, clientGroups);
  const equilibrada = pickEquilibrada(falta, clientGroups);
  const maisOportunidades = pickMaisOportunidades(falta, clientGroups);

  return {
    menos_clientes: buildResult(
      'menos_clientes',
      'Menos clientes',
      'Prioriza orçamentos de maior valor para atingir a meta com a menor quantidade de clientes.',
      menosClientes
    ),
    equilibrada: buildResult(
      'equilibrada',
      'Equilibrada',
      'Combina diferentes faixas de valores para alcançar uma distribuição equilibrada entre clientes.',
      equilibrada
    ),
    mais_oportunidades: buildResult(
      'mais_oportunidades',
      'Mais oportunidades',
      'Distribui a meta entre mais clientes, priorizando combinações com maior quantidade de oportunidades.',
      maisOportunidades
    ),
  };
}
