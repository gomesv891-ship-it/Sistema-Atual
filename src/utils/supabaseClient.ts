import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Default project configuration provided by the user
export const DEFAULT_SUPABASE_URL = 'https://rewcifdxtwvwabnxbafx.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_6oTfXVQa1z45xtlAfSyK2g_Ad2gs-el';

// Storage keys for user credentials (persisted in localStorage, with defaults fallback)
export const STORAGE_SUPABASE_URL_KEY = 'fenix_supabase_url';
export const STORAGE_SUPABASE_KEY_KEY = 'fenix_supabase_anon_key';
export const STORAGE_SUPABASE_AUTO_SYNC_KEY = 'fenix_supabase_auto_sync';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  autoSync: boolean;
}

export interface SupabaseSyncStatus {
  connected: boolean;
  isSyncing: boolean;
  lastSyncTime: string | null;
  error: string | null;
  tablesStatus?: Record<string, { count: number; error?: string }>;
}

let supabaseClientInstance: SupabaseClient | null = null;
let currentClientUrl = '';
let currentClientKey = '';

// Cache em memória resiliente contra QuotaExceededError do localStorage (~5 MB)
const memoryCollectionCache = new Map<string, string>();
const localStorageWriteFailedKeys = new Set<string>();

function evictExpendableLocalStorageCaches(preserveKey?: string) {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToCheck: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keysToCheck.push(k);
    }

    const expendablePrefixes = ['fenix_test_', 'fenix_orcamento_in_progress_draft'];
    for (const k of keysToCheck) {
      if (k === preserveKey) continue;
      if (expendablePrefixes.some((p) => k.startsWith(p))) {
        try {
          localStorage.removeItem(k);
        } catch {}
      }
    }

    // Se houver cópia legada de follow-up e a v2 existir, libera a legada
    if (preserveKey !== 'fenix_followup_db' && localStorage.getItem('fenix_followup_cards_v2')) {
      try {
        localStorage.removeItem('fenix_followup_db');
      } catch {}
    }

    // Notificações e histórico de atividades podem crescer muito e têm fonte no Supabase
    for (const secondaryKey of ['fenix_activities_db', 'fenix_header_notifications_v2']) {
      if (secondaryKey !== preserveKey) {
        try {
          const val = localStorage.getItem(secondaryKey);
          if (val && val.length > 50000) {
            if (!memoryCollectionCache.has(secondaryKey)) {
              memoryCollectionCache.set(secondaryKey, val);
            }
            localStorage.removeItem(secondaryKey);
          }
        } catch {}
      }
    }
  } catch {
    // ignore
  }
}

export function setLocalCollectionSafe(key: string, data: any): boolean {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  memoryCollectionCache.set(key, serialized);

  if (typeof localStorage === 'undefined') return true;
  try {
    localStorage.setItem(key, serialized);
    localStorageWriteFailedKeys.delete(key);
    return true;
  } catch {
    // Tenta liberar caches secundários/temporários e repetir uma vez
    evictExpendableLocalStorageCaches(key);
    try {
      localStorage.setItem(key, serialized);
      localStorageWriteFailedKeys.delete(key);
      return true;
    } catch {
      localStorageWriteFailedKeys.add(key);
      return false;
    }
  }
}

export function getLocalRawSafe(key: string): string | null {
  const memVal = memoryCollectionCache.get(key) ?? null;

  if (typeof localStorage === 'undefined') {
    return memVal;
  }

  if (localStorageWriteFailedKeys.has(key) && memVal !== null) {
    return memVal;
  }

  try {
    const lsVal = localStorage.getItem(key);
    if (lsVal === null || lsVal === '' || lsVal === '[]') {
      if (memVal !== null && memVal !== '' && memVal !== '[]') {
        return memVal;
      }
    }
    return lsVal ?? memVal;
  } catch {
    return memVal;
  }
}

export function getLocalCollectionSafe<T = any>(key: string, fallback: T[] = []): T[] {
  try {
    const raw = getLocalRawSafe(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Limpeza de segurança defensiva: remover credenciais legadas do localStorage
if (typeof window !== 'undefined') {
  try {
    localStorage.removeItem(STORAGE_SUPABASE_URL_KEY);
    localStorage.removeItem(STORAGE_SUPABASE_KEY_KEY);
  } catch {
    // ignore
  }
}

/**
 * Retrieves the current configured URL directly from project configuration/environment
 */
export function getSupabaseUrl(): string {
  // Garantir que não existam credenciais legadas no localStorage
  try {
    localStorage.removeItem(STORAGE_SUPABASE_URL_KEY);
  } catch {
    // ignore
  }
  const envUrl = (import.meta as any).env?.VITE_SUPABASE_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return normalizeSupabaseUrl(envUrl.trim());
  }
  return DEFAULT_SUPABASE_URL;
}

/**
 * Cleans and normalizes URL by removing trailing slashes and /rest/v1 if included
 */
export function normalizeSupabaseUrl(rawUrl: string): string {
  let u = rawUrl.trim();
  // Remove /rest/v1 or /rest/v1/ suffix if pasted
  u = u.replace(/\/rest\/v1\/?$/, '');
  // Remove trailing slashes
  u = u.replace(/\/+$/, '');
  return u;
}

/**
 * Retrieves the current configured Anon Key directly from project configuration/environment
 */
export function getSupabaseAnonKey(): string {
  // Garantir que não existam credenciais legadas no localStorage
  try {
    localStorage.removeItem(STORAGE_SUPABASE_KEY_KEY);
  } catch {
    // ignore
  }
  const envKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY;
  if (envKey && typeof envKey === 'string' && envKey.trim()) {
    return envKey.trim();
  }
  return DEFAULT_SUPABASE_ANON_KEY;
}

/**
 * Check if auto-sync is enabled (defaults to true)
 */
export function isSupabaseAutoSyncEnabled(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_SUPABASE_AUTO_SYNC_KEY);
    if (saved !== null) {
      return saved === 'true';
    }
  } catch {
    // ignore
  }
  return true;
}

export function setSupabaseAutoSyncEnabled(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_SUPABASE_AUTO_SYNC_KEY, enabled ? 'true' : 'false');
    window.dispatchEvent(new CustomEvent('fenix_supabase_config_changed'));
  } catch {
    // ignore
  }
}

/**
 * Saves sync settings without storing credentials in localStorage
 */
export function saveSupabaseConfig(_url?: string, _anonKey?: string, autoSync = true) {
  try {
    localStorage.removeItem(STORAGE_SUPABASE_URL_KEY);
    localStorage.removeItem(STORAGE_SUPABASE_KEY_KEY);
    localStorage.setItem(STORAGE_SUPABASE_AUTO_SYNC_KEY, autoSync ? 'true' : 'false');
    // Invalidate client instance so it rebuilds on next call
    supabaseClientInstance = null;
    currentClientUrl = '';
    currentClientKey = '';
    window.dispatchEvent(new CustomEvent('fenix_supabase_config_changed'));
  } catch (err) {
    console.error('Erro ao salvar configurações de sincronização do Supabase:', err);
  }
}

/**
 * Gets or initializes the Supabase client safely
 */
export function getSupabaseClient(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();

  if (!url || !key) return null;

  if (supabaseClientInstance && currentClientUrl === url && currentClientKey === key) {
    return supabaseClientInstance;
  }

  try {
    supabaseClientInstance = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
    currentClientUrl = url;
    currentClientKey = key;
    return supabaseClientInstance;
  } catch (err) {
    console.error('Falha ao inicializar cliente Supabase:', err);
    return null;
  }
}

// Global sync state and listeners
let currentSyncStatus: SupabaseSyncStatus = {
  connected: false,
  isSyncing: false,
  lastSyncTime: null,
  error: null,
};

const listeners = new Set<(status: SupabaseSyncStatus) => void>();

export function getSupabaseSyncStatus(): SupabaseSyncStatus {
  return { ...currentSyncStatus };
}

export function subscribeSupabaseSyncStatus(listener: (status: SupabaseSyncStatus) => void): () => void {
  listeners.add(listener);
  listener({ ...currentSyncStatus });
  return () => {
    listeners.delete(listener);
  };
}

function notifyStatus() {
  const status = { ...currentSyncStatus };
  listeners.forEach((fn) => {
    try {
      fn(status);
    } catch {
      // ignore
    }
  });
  window.dispatchEvent(new CustomEvent('fenix_supabase_status_changed', { detail: status }));
}

/**
 * Tests connection with Supabase by issuing a lightweight health check
 */
export async function testSupabaseConnection(): Promise<{ success: boolean; error?: string; message?: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, error: 'Credenciais do Supabase não configuradas.' };
  }

  try {
    currentSyncStatus.isSyncing = true;
    notifyStatus();

    // Probe the rest endpoint with the anon key
    const url = getSupabaseUrl();
    const key = getSupabaseAnonKey();
    const res = await fetch(`${url}/rest/v1/fenix_kv_store?select=key&limit=1`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    if (res.status === 200) {
      currentSyncStatus.connected = true;
      currentSyncStatus.error = null;
      currentSyncStatus.isSyncing = false;
      notifyStatus();
      return { success: true, message: 'Conectado com sucesso ao Supabase! Tabela sincronizada.' };
    }

    // If 404, table doesn't exist yet, but credentials and network are 100% valid!
    if (res.status === 404) {
      currentSyncStatus.connected = true;
      currentSyncStatus.error = null;
      currentSyncStatus.isSyncing = false;
      notifyStatus();
      return {
        success: true,
        message: 'Conectado ao Supabase com sucesso! (Tabela de sincronização pronta para ser criada via script SQL).',
      };
    }

    if (res.status === 401 || res.status === 403) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Chave anon/publishable inválida ou sem permissão (${res.status}): ${errText}`);
    }

    currentSyncStatus.connected = true;
    currentSyncStatus.error = null;
    currentSyncStatus.isSyncing = false;
    notifyStatus();
    return { success: true, message: `Conectado ao projeto Supabase (status HTTP ${res.status}).` };
  } catch (err: any) {
    const errorMsg = err?.message || 'Falha ao conectar com o Supabase.';
    currentSyncStatus.connected = false;
    currentSyncStatus.error = errorMsg;
    currentSyncStatus.isSyncing = false;
    notifyStatus();
    return { success: false, error: errorMsg };
  }
}

/**
 * List of primary localStorage collections to sync with Supabase
 */
export const SYNC_COLLECTIONS: { key: string; label: string; description: string }[] = [
  { key: 'fenix_clients_db', label: 'Clientes', description: 'Cadastro e perfil dos clientes' },
  { key: 'fenix_orcamentos_history', label: 'Histórico de Orçamentos', description: 'Todos os orçamentos emitidos' },
  { key: 'fenix_saved_orcamentos', label: 'Orçamentos Salvos', description: 'Modelos e propostas gravadas' },
  { key: 'fenix_product_items_data', label: 'Produtos', description: 'Catálogo de itens e preços' },
  { key: 'fenix_product_categories_data', label: 'Categorias de Produtos', description: 'Categorias oficiais' },
  { key: 'fenix_product_groups_data', label: 'Grupos de Produtos', description: 'Grupos de acabamentos' },
  { key: 'fenix_followup_cards_v2', label: 'Follow-up (Cards)', description: 'Pipeline de acompanhamento comercial' },
  { key: 'fenix_prospeccao_clients_db', label: 'Prospecção', description: 'Clientes e contatos em prospecção' },
  { key: 'fenix_tarefas_db', label: 'Tarefas', description: 'Lista e status de tarefas da equipe' },
  { key: 'fenix_pos_vendas_db', label: 'Pós-Vendas', description: 'Atendimentos de pós-venda' },
  { key: 'fenix_boletos_db', label: 'Boletos', description: 'Controle de boletos e vencimentos' },
  { key: 'fenix_pendencias_v1', label: 'Pendências', description: 'Avisos e pendências operacionais' },
  { key: 'fenix_header_notifications_v2', label: 'Notificações', description: 'Notificações do sistema e alertas entre usuários' },
  { key: 'fenix_activities_db', label: 'Atividades e Histórico', description: 'Registro de atividades e eventos' },
  { key: 'fenix_notes_db', label: 'Anotações', description: 'Blocos de notas e registros internos' },
  { key: 'fenix_usuarios_v2', label: 'Usuários do Sistema', description: 'Contas, cargos e módulos autorizados' },
  { key: 'fenix_auth_users_v2', label: 'Contas de Acesso (Auth)', description: 'Senhas, logins e status dos usuários' },
  { key: 'fenix_metas_sales_db', label: 'Vendas das Metas', description: 'Lançamentos de vendas do mês' },
  { key: 'fenix_visitas_db', label: 'Visitas Técnicas', description: 'Vistorias e medições' },
  { key: 'fenix_agendamento_visitas', label: 'Visitas Técnicas (Oficial)', description: 'Vistorias e medições oficiais' },
  { key: 'fenix_instalacoes_db', label: 'Instalações', description: 'Obras e cronogramas de montagem' },
  { key: 'fenix_agendamento_instalacoes', label: 'Instalações (Oficial)', description: 'Obras e cronogramas de montagem oficiais' },
  { key: 'fenix_retornos_db', label: 'Retornos Operacionais', description: 'Retornos e assistências técnicas' },
  { key: 'fenix_agendamento_retornos', label: 'Retornos Operacionais (Oficial)', description: 'Retornos e assistências técnicas oficiais' },
  { key: 'fenix_instaladores_db', label: 'Instaladores', description: 'Equipes e montadores cadastrados' },
  { key: 'fenix_agendamento_instaladores', label: 'Instaladores (Oficial)', description: 'Equipes e montadores cadastrados oficiais' },
  { key: 'fenix_estoque_items', label: 'Estoque (Itens)', description: 'Produtos, saldos e status do estoque' },
  { key: 'fenix_estoque_categories', label: 'Estoque (Categorias)', description: 'Categorias manuais e independentes de estoque' },
  { key: 'fenix_estoque_groups', label: 'Estoque (Grupos)', description: 'Grupos manuais e independentes de estoque' },
  { key: 'fenix_estoque_movimentacoes', label: 'Movimentações de Estoque', description: 'Entradas, Saídas - Venda e Saídas - Outro' },
  { key: 'fenix_estoque_insumos_v1', label: 'Insumos de Loja', description: 'Materiais de consumo e ferramentas' },
  { key: 'fenix_vendas_gerencial', label: 'Gestão de Vendas (Diretoria)', description: 'Vendas, custos, lucros e margens' },
  { key: 'fenix_marketplace_sales_db', label: 'Vendas Marketplace (Jeferson)', description: 'Lançamentos de vendas marketplace' },
  { key: 'fenix_estoque_insumos_movs_v1', label: 'Insumos de Loja (Movimentações)', description: 'Entradas e saídas de insumos' },
  { key: 'fenix_product_costs_db', label: 'Custos dos Produtos (Diretoria)', description: 'Tabela oficial de custos' },
  { key: 'fenix_custos_estrutura_v1', label: 'Custos de Estrutura', description: 'Custos fixos e operacionais' },
  { key: 'fenix_custos_comissoes_v1', label: 'Custos de Comissões', description: 'Comissões comerciais' },
  { key: 'fenix_custos_nota_fiscal_v1', label: 'Custos de Nota Fiscal', description: 'Alíquotas fiscais' },
  { key: 'fenix_custos_rateio_v1', label: 'Custos de Rateio', description: 'Rateios de custos' },
  { key: 'fenix_custos_tarkett_itens_v1', label: 'Itens Tarkett', description: 'Tabela de itens e acabamentos Tarkett' },
  { key: 'fenix_tarkett_produtos_catalogo', label: 'Catálogo Tarkett', description: 'Produtos do catálogo Tarkett' },
  { key: 'fenix_calculadora_rendimentos', label: 'Rendimentos da Calculadora', description: 'Base independente de rendimentos técnicos' },
  { key: 'fenix_custos_variaveis_v1', label: 'Custos Variáveis', description: 'Configuração de custos variáveis' },
  { key: 'fenix_whatsapp_templates_by_category', label: 'Modelos WhatsApp', description: 'Modelos de mensagens do WhatsApp por categoria' },
  { key: 'fenix_metas_config_data', label: 'Configurações de Metas', description: 'Parâmetros e metas mensais' },
  { key: 'fenix_promocoes_ativas_db', label: 'Promoções Ativas', description: 'Campanhas promocionais, lotes compartilhados e tabelas por modalidade' },
];

// Registro de timestamps locais para supressão de eco no Realtime (evita re-renderizações e loops)
const lastSelfSavedTimestamps: Record<string, string> = {};

export function recordSelfSave(key: string, timestampIso: string) {
  lastSelfSavedTimestamps[key] = timestampIso;
}

export function isRecentSelfSave(key: string, timestampIso?: string): boolean {
  if (!timestampIso) return false;
  return lastSelfSavedTimestamps[key] === timestampIso;
}

// Fila offline para proteção total contra perda de dados em falhas de rede
const OFFLINE_SYNC_QUEUE_KEY = 'fenix_pending_sync_queue_v1';

export interface PendingSyncItem {
  id: string;
  collectionKey: string;
  item: any;
  idField: string;
  user: string;
  timestamp: number;
}

export function queuePendingItem(collectionKey: string, item: any, idField: string, user: string) {
  try {
    const raw = localStorage.getItem(OFFLINE_SYNC_QUEUE_KEY);
    const queue: PendingSyncItem[] = raw ? JSON.parse(raw) : [];
    const itemId = String(item[idField] ?? item.id ?? Date.now());
    const filtered = queue.filter(
      (q) => !(q.collectionKey === collectionKey && String(q.item[idField] ?? q.item.id) === itemId)
    );
    filtered.push({
      id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      collectionKey,
      item,
      idField,
      user,
      timestamp: Date.now(),
    });
    localStorage.setItem(OFFLINE_SYNC_QUEUE_KEY, JSON.stringify(filtered));
  } catch (err) {
    console.warn('Erro ao registrar item na fila offline:', err);
  }
}

/**
 * Utilitário de timeout seguro: se a promessa exceder timeoutMs, retorna fallbackValue sem travar
 */
export function withTimeout<T = any>(
  promiseOrThenable: any,
  timeoutMs: number,
  fallbackValue: T
): Promise<T> {
  const promise = Promise.resolve(promiseOrThenable);
  let timer: any;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallbackValue);
    }, timeoutMs);
  });
  return Promise.race([
    promise
      .then((res) => {
        clearTimeout(timer);
        return res;
      })
      .catch((err) => {
        clearTimeout(timer);
        console.warn('Promise capturada com fallback no withTimeout:', err);
        return fallbackValue;
      }),
    timeoutPromise,
  ]);
}

/**
 * Utilitário de resiliência com retentativa exponencial e detecção aprofundada de erros transitórios
 * (como PGRST002 "schema cache reload", 503 "Service Unavailable", 57014 "statement timeout", 55P03 lock timeouts e quedas de rede).
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 4,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      const isTransient =
        err?.code === 'PGRST002' ||
        err?.code === '57014' ||
        err?.code === '55P03' ||
        err?.code === 'PGRST000' ||
        err?.status === 500 ||
        err?.status === 502 ||
        err?.status === 503 ||
        err?.status === 504 ||
        err?.message?.includes('schema cache') ||
        err?.message?.includes('statement timeout') ||
        err?.message?.includes('lock timeout') ||
        err?.message?.includes('Failed to fetch') ||
        err?.message?.includes('NetworkError') ||
        err?.message?.includes('network') ||
        err?.message?.includes('aborted');

      if (attempt < maxRetries && isTransient) {
        const jitter = Math.floor(Math.random() * 250);
        const delay = Math.round(baseDelayMs * Math.pow(1.5, attempt - 1)) + jitter;
        console.warn(`[SUPABASE-RETRY] Tentativa ${attempt}/${maxRetries} falhou com erro transitório (${err?.code || err?.message}). Aguardando ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

/**
 * SQL script to easily create and harden the synchronization table in Supabase SQL Editor
 * Includes strict RLS policies (preventing arbitrary deletes, validating allowed keys and payload sizes)
 */
export const SUPABASE_SETUP_SQL = `-- ==============================================================================
-- ATUALIZAÇÃO E BLINDAGEM DE SEGURANÇA (RLS) - CRM FÊNIX WORLD
-- Execute este script no "SQL Editor" do Supabase:
-- https://supabase.com/dashboard/project/rewcifdxtwvwabnxbafx/sql
-- ==============================================================================

-- 1. Garante que a tabela existe com tipos e restrições seguras
CREATE TABLE IF NOT EXISTS public.fenix_kv_store (
    key text PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz DEFAULT now(),
    updated_by text DEFAULT 'CRM Fênix'
);

-- 2. Habilita obrigatoriamente Row Level Security (RLS)
ALTER TABLE public.fenix_kv_store ENABLE ROW LEVEL SECURITY;

-- 3. Remove políticas antigas/permissivas demais para aplicar as regras blindadas
DROP POLICY IF EXISTS "Permitir leitura anonima no CRM" ON public.fenix_kv_store;
DROP POLICY IF EXISTS "Permitir insercao e atualizacao anonima no CRM" ON public.fenix_kv_store;
DROP POLICY IF EXISTS "CRM Fenix: Leitura de dados autenticados e anonimos" ON public.fenix_kv_store;
DROP POLICY IF EXISTS "CRM Fenix: Insercao de colecoes validas" ON public.fenix_kv_store;
DROP POLICY IF EXISTS "CRM Fenix: Atualizacao de colecoes validas" ON public.fenix_kv_store;
DROP POLICY IF EXISTS "CRM Fenix: Bloqueio de exclusao acidental" ON public.fenix_kv_store;

-- 4. POLÍTICA DE LEITURA (SELECT):
-- Permite leitura apenas de chaves legítimas do sistema Fênix
CREATE POLICY "CRM Fenix: Leitura de colecoes validas"
ON public.fenix_kv_store
FOR SELECT
TO anon, authenticated
USING (
    key LIKE 'fenix_%'
);

-- 5. POLÍTICA DE INSERÇÃO (INSERT):
-- Previne injeção de tabelas desconhecidas ou spam (limite de 15MB por payload)
CREATE POLICY "CRM Fenix: Insercao de colecoes validas"
ON public.fenix_kv_store
FOR INSERT
TO anon, authenticated
WITH CHECK (
    key LIKE 'fenix_%'
    AND length(key) <= 120
    AND pg_column_size(data) <= 15728640
);

-- 6. POLÍTICA DE ATUALIZAÇÃO (UPDATE):
-- Permite atualizar registros existentes mantendo a integridade
CREATE POLICY "CRM Fenix: Atualizacao de colecoes validas"
ON public.fenix_kv_store
FOR UPDATE
TO anon, authenticated
USING (key LIKE 'fenix_%')
WITH CHECK (
    key LIKE 'fenix_%'
    AND length(key) <= 120
    AND pg_column_size(data) <= 15728640
);

-- 7. POLÍTICA DE EXCLUSÃO (DELETE):
-- Nenhuma requisição anônima pública pode apagar registros inteiros acidentalmente
CREATE POLICY "CRM Fenix: Bloqueio de exclusao publica"
ON public.fenix_kv_store
FOR DELETE
TO authenticated
USING (key LIKE 'fenix_%');

-- ==============================================================================
-- 8. CRIAÇÃO E CONFIGURAÇÃO DOS BUCKETS NO SUPABASE STORAGE
-- ==============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
  ('catalogos', 'catalogos', true, 104857600, NULL),
  ('documentos', 'documentos', true, 104857600, NULL),
  ('modelos', 'modelos', true, 104857600, NULL)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Políticas de RLS para acesso e upload aos arquivos no Supabase Storage:
DROP POLICY IF EXISTS "CRM Fenix Storage: Leitura publica de arquivos" ON storage.objects;
DROP POLICY IF EXISTS "CRM Fenix Storage: Upload de arquivos" ON storage.objects;
DROP POLICY IF EXISTS "CRM Fenix Storage: Atualizacao de arquivos" ON storage.objects;
DROP POLICY IF EXISTS "CRM Fenix Storage: Exclusao de arquivos" ON storage.objects;

CREATE POLICY "CRM Fenix Storage: Leitura publica de arquivos"
ON storage.objects FOR SELECT
TO public
USING (bucket_id IN ('catalogos', 'documentos', 'modelos'));

CREATE POLICY "CRM Fenix Storage: Upload de arquivos"
ON storage.objects FOR INSERT
TO public
WITH CHECK (bucket_id IN ('catalogos', 'documentos', 'modelos'));

CREATE POLICY "CRM Fenix Storage: Atualizacao de arquivos"
ON storage.objects FOR UPDATE
TO public
USING (bucket_id IN ('catalogos', 'documentos', 'modelos'));

CREATE POLICY "CRM Fenix Storage: Exclusao de arquivos"
ON storage.objects FOR DELETE
TO public
USING (bucket_id IN ('catalogos', 'documentos', 'modelos'));

-- Confirmação
SELECT 'Políticas RLS e Buckets de Storage do CRM Fênix aplicados e blindados com sucesso!' AS status;
`;

/**
 * Sends all local data from localStorage to Supabase (Backup / Push)
 */
export async function pushAllLocalDataToSupabase(currentUser = 'Vanessa Gomes'): Promise<{
  success: boolean;
  syncedCount: number;
  error?: string;
  details?: Record<string, boolean>;
}> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, syncedCount: 0, error: 'Supabase não inicializado.' };
  }

  currentSyncStatus.isSyncing = true;
  notifyStatus();

  let syncedCount = 0;
  const details: Record<string, boolean> = {};

  try {
    for (const col of SYNC_COLLECTIONS) {
      try {
        const raw = localStorage.getItem(col.key);
        if (raw === null) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }

        const payload = {
          key: col.key,
          data: parsed,
          updated_at: new Date().toISOString(),
          updated_by: currentUser,
        };

        const { error } = await client
          .from('fenix_kv_store')
          .upsert(payload, { onConflict: 'key' });

        if (error) {
          console.warn(`Erro ao sincronizar chave ${col.key} no Supabase:`, error);
          details[col.key] = false;
        } else {
          syncedCount++;
          details[col.key] = true;
        }
      } catch (colErr) {
        console.warn(`Exceção na chave ${col.key}:`, colErr);
        details[col.key] = false;
      }
    }

    currentSyncStatus.connected = true;
    currentSyncStatus.lastSyncTime = new Date().toLocaleTimeString('pt-BR');
    currentSyncStatus.error = null;
    currentSyncStatus.isSyncing = false;
    notifyStatus();

    return {
      success: syncedCount > 0,
      syncedCount,
      details,
    };
  } catch (err: any) {
    const errorMsg = err?.message || 'Erro durante sincronização com Supabase.';
    currentSyncStatus.isSyncing = false;
    currentSyncStatus.error = errorMsg;
    notifyStatus();
    return { success: false, syncedCount, error: errorMsg };
  }
}

/**
 * Dispatches targeted and general events to notify all active UI components
 */
export function dispatchCollectionEvents(collectionKey: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event('storage'));
  if (collectionKey === 'fenix_clients_db') window.dispatchEvent(new Event('fenix_clients_updated'));
  if (collectionKey.includes('orcamento')) window.dispatchEvent(new Event('fenix_orcamentos_updated'));
  if (collectionKey.includes('followup')) window.dispatchEvent(new Event('fenix_followup_updated'));
  if (collectionKey.includes('tarefas')) window.dispatchEvent(new Event('fenix_tarefas_updated'));
  if (collectionKey.includes('metas')) {
    window.dispatchEvent(new Event('fenix_metas_updated'));
    window.dispatchEvent(new Event('fenix_metas_config_updated'));
  }
  if (collectionKey.includes('usuarios') || collectionKey.includes('auth')) {
    window.dispatchEvent(new Event('fenix_auth_updated'));
    window.dispatchEvent(new Event('fenix_users_updated'));
  }
  if (collectionKey.includes('notes')) window.dispatchEvent(new Event('fenix_notes_updated'));
  if (collectionKey.includes('pendencias')) window.dispatchEvent(new Event('fenix_pendencias_updated'));
  if (collectionKey.includes('notification')) window.dispatchEvent(new Event('fenix_notifications_updated'));
  if (collectionKey.includes('product')) window.dispatchEvent(new Event('fenix_products_updated'));
  if (
    collectionKey.includes('pos_vendas') ||
    collectionKey.includes('agendamento') ||
    collectionKey.includes('visitas') ||
    collectionKey.includes('instalac') ||
    collectionKey.includes('retorno') ||
    collectionKey.includes('instalador')
  ) {
    window.dispatchEvent(new Event('fenix_pos_vendas_updated'));
    window.dispatchEvent(new Event('fenix_agendamento_updated'));
  }
  if (collectionKey.includes('boletos')) window.dispatchEvent(new Event('fenix_boletos_updated'));
  if (collectionKey.includes('estoque')) {
    window.dispatchEvent(new Event('fenix_estoque_updated'));
    window.dispatchEvent(new Event('fenix_estoque_items'));
    window.dispatchEvent(new Event('fenix_estoque_movimentacoes'));
  }
  if (collectionKey.includes('vendas')) {
    window.dispatchEvent(new Event('fenix_vendas_updated'));
    window.dispatchEvent(new Event('fenix_vendas_gerencial_updated'));
  }
  if (collectionKey.includes('marketplace')) window.dispatchEvent(new Event('fenix_marketplace_sales_updated'));
  if (collectionKey.includes('rendimentos')) window.dispatchEvent(new Event('fenix_rendimentos_updated'));
  if (collectionKey.includes('custos')) {
    window.dispatchEvent(new Event('fenix_custos_config_updated'));
    window.dispatchEvent(new Event('fenix_custos_variaveis_updated'));
    window.dispatchEvent(new Event('fenix_custos_tarkett_updated'));
  }
  if (collectionKey.includes('tarkett')) {
    window.dispatchEvent(new Event('fenix_tarkett_produtos_updated'));
    window.dispatchEvent(new Event('fenix_custos_tarkett_updated'));
  }
  if (collectionKey.includes('whatsapp') || collectionKey.includes('msg')) window.dispatchEvent(new Event('fenix_orcamento_msg_updated'));
  if (collectionKey.includes('promoc')) window.dispatchEvent(new Event('fenix_promocoes_updated'));
}

/**
 * Helper to ensure a list has strictly unique items by an idField.
 */
export function deduplicateListById<T = any>(list: T[], idField = 'id'): T[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of list) {
    if (!item) continue;
    const val = (item as any)[idField] ?? (item as any).id ?? (item as any)._id ?? (item as any).idOrcamento ?? (item as any).pedido ?? (item as any).codigo;
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      const key = String(val).trim();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Merge seguro e atômico de duas listas (remota e local):
 * - Preserva todos os registros existentes.
 * - Atualiza os campos dos registros coincidentes pelo ID.
 * - NUNCA descarta itens remotos ou locais.
 */
export function safeMergeLists<T = any>(
  primaryList: T[],
  secondaryList: T[],
  idField = 'id'
): T[] {
  if (!Array.isArray(primaryList)) primaryList = [];
  if (!Array.isArray(secondaryList)) secondaryList = [];

  const map = new Map<string, T>();

  const extractId = (item: any): string | null => {
    if (!item || typeof item !== 'object') return null;
    const v =
      item[idField] ??
      item.id ??
      item._id ??
      item.idOrcamento ??
      item.orcamentoId ??
      item.pedido ??
      item.codigo ??
      item.uuid;
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return String(v).trim();
    }
    return null;
  };

  // 1. Processa lista primária (ex: dados remotos já persistidos)
  for (const item of primaryList) {
    if (!item) continue;
    const key = extractId(item);
    if (key) {
      map.set(key, item);
    } else {
      map.set(`gen_key_${Math.random().toString(36).slice(2)}`, item);
    }
  }

  // 2. Mescla lista secundária (ex: alterações mais recentes ou locais)
  for (const item of secondaryList) {
    if (!item) continue;
    const key = extractId(item);
    if (key) {
      const existing = map.get(key);
      if (existing) {
        // Merge seguro mantendo campos pré-existentes e protegendo status 'Vendido' / 'Fechado'
        const existingStatus = String((existing as any).status || '').trim();
        const incomingStatus = String((item as any).status || '').trim();
        const isExistingSold = existingStatus === 'Vendido' || existingStatus === 'Fechado' || existingStatus === 'Fechados';
        const isIncomingSold = incomingStatus === 'Vendido' || incomingStatus === 'Fechado' || incomingStatus === 'Fechados';

        const merged: any = { ...existing, ...item };
        // Se o registro já estava como Vendido e o item secundário tem status diferente sem atualização mais nova, preserva Vendido
        if (isExistingSold && !isIncomingSold) {
          const existingUpdated = (existing as any).dataAtualizacao || (existing as any).updatedAt;
          const incomingUpdated = (item as any).dataAtualizacao || (item as any).updatedAt;
          if (!incomingUpdated || (existingUpdated && new Date(existingUpdated).getTime() >= new Date(incomingUpdated).getTime())) {
            merged.status = (existing as any).status;
            if ((existing as any).pedido) merged.pedido = (existing as any).pedido;
            if ((existing as any).formaPagamento) merged.formaPagamento = (existing as any).formaPagamento;
            if ((existing as any).formasPagamento) merged.formasPagamento = (existing as any).formasPagamento;
          }
        } else if (isIncomingSold) {
          merged.status = 'Vendido';
        }
        map.set(key, merged);
      } else {
        map.set(key, item);
      }
    } else {
      map.set(`gen_key_${Math.random().toString(36).slice(2)}`, item);
    }
  }

  return Array.from(map.values());
}

/**
 * Esvazia e processa a fila de operações pendentes geradas em momentos de instabilidade/offline
 */
export async function drainPendingSyncQueue(): Promise<number> {
  const client = getSupabaseClient();
  if (!client) return 0;
  try {
    const raw = localStorage.getItem(OFFLINE_SYNC_QUEUE_KEY);
    if (!raw) return 0;
    const queue: PendingSyncItem[] = JSON.parse(raw);
    if (!Array.isArray(queue) || queue.length === 0) return 0;

    let synced = 0;
    const remaining: PendingSyncItem[] = [];

    for (const q of queue) {
      try {
        const res = await saveItemToSupabase(q.collectionKey, q.item, q.idField, q.user);
        if (res.success) {
          synced++;
        } else {
          remaining.push(q);
        }
      } catch {
        remaining.push(q);
      }
    }

    if (remaining.length === 0) {
      localStorage.removeItem(OFFLINE_SYNC_QUEUE_KEY);
    } else {
      localStorage.setItem(OFFLINE_SYNC_QUEUE_KEY, JSON.stringify(remaining));
    }
    return synced;
  } catch {
    return 0;
  }
}

/**
 * Initializes a Supabase Realtime channel subscription to receive instant updates
 * whenever any row in fenix_kv_store changes across any connected client.
 * Com supressão de eco local para evitar re-renderizações e loops infinitos.
 */
export function initSupabaseRealtimeSubscription(): (() => void) | null {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const channel = client
      .channel('fenix_realtime_sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'fenix_kv_store' },
        (payload: any) => {
          if (payload?.new && payload.new.key && payload.new.data !== undefined) {
            const key = payload.new.key;
            // Arquivos binários/PDFs em base64 não devem ser gravados via stream simples
            if (key.startsWith('fenix_file_') || key.startsWith('fenix_test_')) {
              return;
            }

            // Supressão de eco: se a alteração foi originada por esta própria sessão, não re-renderizar
            const updatedAt = payload.new.updated_at;
            if (isRecentSelfSave(key, updatedAt)) {
              return;
            }

            // A coleção fenix_anotacoes_db é gerenciada diretamente via Supabase sem localStorage
            if (key === 'fenix_anotacoes_db') {
              window.dispatchEvent(new CustomEvent('fenix_anotacoes_realtime_updated', { detail: payload.new }));
              return;
            }

            // A coleção fenix_promocoes_ativas_db é sincronizada via promocoesService
            if (key === 'fenix_promocoes_ativas_db') {
              window.dispatchEvent(new CustomEvent('fenix_promocoes_realtime_updated', { detail: payload.new }));
              return;
            }

            try {
              let parsedData = payload.new.data;
              if (typeof parsedData === 'string') {
                try {
                  parsedData = JSON.parse(parsedData);
                } catch {}
              }

              // Proteção anti-sobrescrita: se recebido array vazio e o local tem dados, preservar local!
              const currentLocalRaw = getLocalRawSafe(key);
              let localList: any[] = [];
              if (currentLocalRaw) {
                try {
                  const p = JSON.parse(currentLocalRaw);
                  if (Array.isArray(p)) localList = p;
                } catch {}
              }

              if (Array.isArray(parsedData)) {
                if (parsedData.length === 0 && localList.length > 0) {
                  console.warn(`[REALTIME-PROTECTION] Ignorada tentativa de wipe em ${key} via Realtime.`);
                  return;
                }
                const merged = safeMergeLists(parsedData, localList, 'id');
                const stringVal = JSON.stringify(merged);
                if (currentLocalRaw !== stringVal) {
                  setLocalCollectionSafe(key, stringVal);
                  dispatchCollectionEvents(key);
                }
              } else {
                const stringVal = typeof parsedData === 'string' ? parsedData : JSON.stringify(parsedData);
                if (currentLocalRaw !== stringVal) {
                  setLocalCollectionSafe(key, stringVal);
                  dispatchCollectionEvents(key);
                }
              }
            } catch (e) {
              console.warn('Erro ao atualizar cache local via Realtime:', e);
            }
          }
        }
      )
      .subscribe();

    return () => {
      try {
        client.removeChannel(channel);
      } catch {
        // ignore
      }
    };
  } catch (err) {
    console.warn('Realtime Supabase não pôde ser iniciado:', err);
    return null;
  }
}

/**
 * Mapeamento de coleções por módulo/aba para carregamento on-demand (lazy load).
 * O sistema carrega os dados de cada módulo somente quando a aba for acessada.
 */
export const TAB_COLLECTIONS_MAP: Record<string, string[]> = {
  'Clientes': ['fenix_clients_db'],
  'Cadastro': ['fenix_clients_db'],
  'Calculadora': ['fenix_clients_db', 'fenix_product_items_data', 'fenix_product_categories_data', 'fenix_product_groups_data', 'fenix_calculadora_rendimentos'],
  'Orçamentos': ['fenix_clients_db', 'fenix_saved_orcamentos', 'fenix_orcamentos_history', 'fenix_product_items_data', 'fenix_product_categories_data'],
  'Agenda': ['fenix_tarefas_db', 'fenix_clients_db'],
  'Tarefas': ['fenix_tarefas_db', 'fenix_clients_db'],
  'Follow-up': ['fenix_followup_cards_v2', 'fenix_clients_db', 'fenix_saved_orcamentos', 'fenix_orcamentos_history', 'fenix_metas_sales_db'],
  'FollowUp': ['fenix_followup_cards_v2', 'fenix_clients_db', 'fenix_saved_orcamentos', 'fenix_orcamentos_history', 'fenix_metas_sales_db'],
  'Obras': ['fenix_pos_vendas_db', 'fenix_agendamento_visitas', 'fenix_agendamento_instalacoes', 'fenix_agendamento_retornos', 'fenix_agendamento_instaladores', 'fenix_clients_db'],
  'Pós-Vendas': ['fenix_pos_vendas_db', 'fenix_agendamento_visitas', 'fenix_agendamento_instalacoes', 'fenix_agendamento_retornos', 'fenix_agendamento_instaladores', 'fenix_clients_db'],
  'PosVendas': ['fenix_pos_vendas_db', 'fenix_agendamento_visitas', 'fenix_agendamento_instalacoes', 'fenix_agendamento_retornos', 'fenix_agendamento_instaladores', 'fenix_clients_db'],
  'Pós Vendas': ['fenix_pos_vendas_db', 'fenix_agendamento_visitas', 'fenix_agendamento_instalacoes', 'fenix_agendamento_retornos', 'fenix_agendamento_instaladores', 'fenix_clients_db'],
  'Boletos': ['fenix_boletos_db', 'fenix_clients_db'],
  'Pendências': ['fenix_pendencias_v1'],
  'Pendencias': ['fenix_pendencias_v1'],
  'Notas': ['fenix_notes_db'],
  'Metas': ['fenix_metas_sales_db', 'fenix_followup_cards_v2', 'fenix_orcamentos_history', 'fenix_saved_orcamentos', 'fenix_clients_db', 'fenix_pos_vendas_db', 'fenix_deleted_vendas_ids', 'fenix_vendas_gerencial', 'fenix_metas_config_data'],
  'Meta': ['fenix_metas_sales_db', 'fenix_followup_cards_v2', 'fenix_orcamentos_history', 'fenix_saved_orcamentos', 'fenix_clients_db', 'fenix_pos_vendas_db', 'fenix_deleted_vendas_ids', 'fenix_vendas_gerencial', 'fenix_metas_config_data'],
  'Produtos': ['fenix_product_items_data', 'fenix_product_categories_data', 'fenix_product_groups_data', 'fenix_product_costs_db', 'fenix_custos_tarkett_itens_v1', 'fenix_tarkett_produtos_catalogo'],
  'Promoções Ativas': ['fenix_promocoes_ativas_db', 'fenix_product_items_data', 'fenix_product_categories_data'],
  'Promocoes Ativas': ['fenix_promocoes_ativas_db', 'fenix_product_items_data', 'fenix_product_categories_data'],
  'Configurações': ['fenix_usuarios_v2', 'fenix_auth_users_v2', 'fenix_custos_estrutura_v1', 'fenix_custos_rateio_v1', 'fenix_custos_comissoes_v1', 'fenix_custos_nota_fiscal_v1', 'fenix_custos_tarkett_itens_v1', 'fenix_tarkett_produtos_catalogo', 'fenix_custos_variaveis_v1', 'fenix_whatsapp_templates_by_category', 'fenix_metas_config_data'],
  'Configuracoes': ['fenix_usuarios_v2', 'fenix_auth_users_v2', 'fenix_custos_estrutura_v1', 'fenix_custos_rateio_v1', 'fenix_custos_comissoes_v1', 'fenix_custos_nota_fiscal_v1', 'fenix_custos_tarkett_itens_v1', 'fenix_tarkett_produtos_catalogo', 'fenix_custos_variaveis_v1', 'fenix_whatsapp_templates_by_category', 'fenix_metas_config_data'],
  'Settings': ['fenix_usuarios_v2', 'fenix_auth_users_v2', 'fenix_custos_estrutura_v1', 'fenix_custos_rateio_v1', 'fenix_custos_comissoes_v1', 'fenix_custos_nota_fiscal_v1', 'fenix_custos_tarkett_itens_v1', 'fenix_tarkett_produtos_catalogo', 'fenix_custos_variaveis_v1', 'fenix_whatsapp_templates_by_category', 'fenix_metas_config_data'],
  'Estoque': ['fenix_estoque_items', 'fenix_estoque_categories', 'fenix_estoque_groups', 'fenix_estoque_movimentacoes'],
  'Controle de Estoque': ['fenix_estoque_items', 'fenix_estoque_categories', 'fenix_estoque_groups', 'fenix_estoque_movimentacoes'],
  'Materiais': ['fenix_estoque_items', 'fenix_estoque_categories', 'fenix_estoque_groups', 'fenix_estoque_movimentacoes'],
  'Vendas': ['fenix_vendas_gerencial', 'fenix_metas_sales_db', 'fenix_marketplace_sales_db', 'fenix_clients_db', 'fenix_deleted_vendas_ids'],
  'Notificações': ['fenix_header_notifications_v2'],
  'Notificacoes': ['fenix_header_notifications_v2'],
};

const moduleLastSyncTime: Record<string, number> = {};

const HEAVY_COLLECTION_KEYS = new Set<string>([
  'fenix_orcamentos_history',
  'fenix_saved_orcamentos',
  'fenix_followup_cards_v2',
  'fenix_header_notifications_v2',
  'fenix_clients_db',
]);

const PROTECTED_MERGE_COLLECTIONS = new Set<string>([
  'fenix_clients_db',
  'fenix_orcamentos_history',
  'fenix_saved_orcamentos',
  'fenix_followup_cards_v2',
  'fenix_metas_sales_db',
  'fenix_pos_vendas_db',
  'fenix_vendas_gerencial',
  'fenix_tarefas_db',
]);

function mergeFollowUpArraysSafe(primaryList: any[], secondaryList: any[]): any[] {
  const fupByRef = new Map<string, any>();
  for (const p of [...primaryList, ...secondaryList]) {
    if (!p) continue;
    const pId = String(p.id ?? '').trim();
    const bareOrc = String(p.orcamentoId || (pId.startsWith('fup_') ? pId.slice(4) : ''))
      .trim()
      .replace(/^orc_/, '');
    const refKey = bareOrc ? `orc_${bareOrc}` : pId;
    if (!refKey) continue;

    const existing = fupByRef.get(refKey);
    if (!existing) {
      fupByRef.set(refKey, p);
    } else {
      const existingStatus = String(existing.status || '').trim().toLowerCase();
      const incomingStatus = String(p.status || '').trim().toLowerCase();
      const existingSold = existingStatus === 'vendido' || existingStatus === 'fechado';
      const incomingSold = incomingStatus === 'vendido' || incomingStatus === 'fechado';

      const existingTs = new Date(existing.updatedAt || existing.dataAtualizacao || 0).getTime() || 0;
      const incomingTs = new Date(p.updatedAt || p.dataAtualizacao || 0).getTime() || 0;
      const mergedHistMap = new Map<string, any>();
      [...(existing.historico || []), ...(p.historico || [])].forEach((h: any) => {
        if (h && h.id) mergedHistMap.set(h.id, h);
      });
      const mergedHist = Array.from(mergedHistMap.values()).sort(
        (a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0)
      );
      const primary =
        incomingSold && !existingSold
          ? p
          : existingSold && !incomingSold
          ? existing
          : incomingTs > existingTs
          ? p
          : existing;
      const secondary = primary === p ? existing : p;
      fupByRef.set(refKey, {
        ...secondary,
        ...primary,
        id: existing.id || primary.id,
        orcamentoId: primary.orcamentoId || secondary.orcamentoId,
        pedido: primary.pedido || secondary.pedido,
        ...(mergedHist.length > 0 ? { historico: mergedHist } : {}),
      });
    }
  }
  return Array.from(fupByRef.values());
}

/**
 * Busca chaves específicas diretamente no Supabase de forma isolada/paralela (sem timeouts em lotes pesados)
 * e hidrata o cache em memória + localStorage com proteção anti-QuotaExceededError.
 */
export async function fetchSupabaseKeysIndividually(
  keys: string[],
  timeoutMs = 15000
): Promise<{
  rows: Map<string, any>;
  succeededKeys: Set<string>;
  failedKeys: string[];
}> {
  const rows = new Map<string, any>();
  const succeededKeys = new Set<string>();
  const failedKeys: string[] = [];

  const client = getSupabaseClient();
  if (!client || !Array.isArray(keys) || keys.length === 0) {
    return { rows, succeededKeys, failedKeys: keys || [] };
  }

  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  const heavyKeys = uniqueKeys.filter((k) => HEAVY_COLLECTION_KEYS.has(k));
  const lightKeys = uniqueKeys.filter((k) => !HEAVY_COLLECTION_KEYS.has(k));

  const queryBatches: string[][] = [];
  for (const hk of heavyKeys) {
    queryBatches.push([hk]);
  }
  for (let i = 0; i < lightKeys.length; i += 5) {
    queryBatches.push(lightKeys.slice(i, i + 5));
  }

  const fetchBatch = async (batch: string[]) => {
    const TIMED_OUT = Symbol('TIMED_OUT');
    try {
      const res = await withTimeout<any>(
        executeWithRetry(async () => {
          const { data, error } = await client
            .from('fenix_kv_store')
            .select('key, data, updated_at')
            .in('key', batch);
          if (error) throw error;
          return data || [];
        }, 2, 500),
        timeoutMs,
        TIMED_OUT
      );

      if (res === TIMED_OUT || !Array.isArray(res)) {
        batch.forEach((k) => failedKeys.push(k));
        return;
      }

      batch.forEach((k) => succeededKeys.add(k));
      for (const row of res) {
        if (!row || !row.key) continue;
        let parsed = row.data;
        if (typeof parsed === 'string') {
          try {
            parsed = JSON.parse(parsed);
          } catch {}
        }
        rows.set(row.key, parsed);
      }
    } catch (err) {
      console.warn(`[SUPABASE-FETCH] Falha ao buscar lote [${batch.join(', ')}]:`, err);
      batch.forEach((k) => failedKeys.push(k));
    }
  };

  // Executa com concorrência máxima de 3 lotes para evitar congestionamento no navegador
  for (let i = 0; i < queryBatches.length; i += 3) {
    const group = queryBatches.slice(i, i + 3);
    await Promise.all(group.map((b) => fetchBatch(b)));
  }

  return { rows, succeededKeys, failedKeys };
}

/**
 * Sincroniza em segundo plano apenas os dados da aba/módulo selecionado.
 * Só atualiza a janela de cache (15s) quando o carregamento concluir sem falhas.
 */
export async function syncModuleData(tabName: string, force = false): Promise<void> {
  const keys = TAB_COLLECTIONS_MAP[tabName];
  if (!keys || keys.length === 0) return;

  const now = Date.now();
  if (!force && moduleLastSyncTime[tabName] && now - moduleLastSyncTime[tabName] < 15000) {
    return;
  }

  const res = await pullDataFromSupabase(keys);
  if (res.success) {
    moduleLastSyncTime[tabName] = Date.now();
  }
}

/**
 * Consulta e atualiza uma única coleção do Supabase com timeout seguro de 12 segundos
 */
export async function pullCollectionFromSupabase(key: string, timeoutMs = 12000): Promise<boolean> {
  const res = await withTimeout(pullDataFromSupabase([key], timeoutMs), timeoutMs + 1000, {
    success: false,
    pulledCount: 0,
  });
  return res.success;
}

/**
 * Consulta e atualiza um conjunto específico de coleções do Supabase com timeout seguro
 */
export async function pullCollectionsFromSupabase(keys: string[], timeoutMs = 15000): Promise<boolean> {
  const res = await withTimeout(pullDataFromSupabase(keys, timeoutMs), timeoutMs + 1000, {
    success: false,
    pulledCount: 0,
  });
  return res.success;
}

/**
 * Pulls data from Supabase into memory cache + localStorage (Restore / Pull).
 * - Busca chaves pesadas individualmente em paralelo com timeout generoso (15s) em vez de 3.5s.
 * - Nunca retorna success: true se lotes falharem/expirarem.
 * - Usa cache em memória seguro para sobreviver a QuotaExceededError no localStorage.
 */
export async function pullDataFromSupabase(
  specificKeys?: string[],
  timeoutMs = 15000
): Promise<{
  success: boolean;
  pulledCount: number;
  error?: string;
}> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, pulledCount: 0, error: 'Supabase não inicializado.' };
  }

  currentSyncStatus.isSyncing = true;
  notifyStatus();

  try {
    let targetKeys: string[];

    if (specificKeys && Array.isArray(specificKeys) && specificKeys.length > 0) {
      targetKeys = specificKeys;
    } else {
      targetKeys = SYNC_COLLECTIONS.map((c) => c.key);
    }

    const { rows, failedKeys } = await fetchSupabaseKeysIndividually(targetKeys, timeoutMs);

    if (rows.size === 0 && failedKeys.length > 0) {
      currentSyncStatus.isSyncing = false;
      currentSyncStatus.error = 'Timeout ou falha de rede ao consultar Supabase.';
      notifyStatus();
      return {
        success: false,
        pulledCount: 0,
        error: currentSyncStatus.error,
      };
    }

    let pulledCount = 0;
    for (const [key, parsedData] of rows.entries()) {
      if (parsedData === undefined) continue;
      try {
        const currentLocalRaw = getLocalRawSafe(key);
        let localList: any[] = [];
        if (currentLocalRaw) {
          try {
            const p = JSON.parse(currentLocalRaw);
            if (Array.isArray(p)) localList = p;
          } catch {}
        }

        let finalData: any = parsedData;

        if (Array.isArray(parsedData)) {
          let pendingItems: any[] = [];
          try {
            const rawQ = getLocalRawSafe(OFFLINE_SYNC_QUEUE_KEY);
            if (rawQ) {
              const q: PendingSyncItem[] = JSON.parse(rawQ);
              if (Array.isArray(q)) {
                pendingItems = q.filter((it) => it.collectionKey === key).map((it) => it.item);
              }
            }
          } catch {}

          if (parsedData.length === 0 && localList.length > 0) {
            finalData = localList;
            saveWholeCollectionToSupabase(key, localList).catch(() => {});
          } else if (parsedData.length > 0) {
            if (key === 'fenix_metas_sales_db') {
              const salesList: any[] = [];
              const findMatchingSaleIdx = (candidate: any): number => {
                const id = String(candidate.id || '').trim();
                const fupId = candidate.followUpId ? String(candidate.followUpId).trim() : '';
                const orcId = candidate.orcamentoId ? String(candidate.orcamentoId).trim() : '';
                const bareOrc = orcId.replace(/^orc_/, '');
                const cleanPed = candidate.pedido ? String(candidate.pedido).replace(/^#+/, '').trim() : '';
                const clientNorm = (candidate.cliente || candidate.clientName || '').trim().toLowerCase();

                return salesList.findIndex((existing) => {
                  const eId = String(existing.id || '').trim();
                  const eFupId = existing.followUpId ? String(existing.followUpId).trim() : '';
                  const eOrcId = existing.orcamentoId ? String(existing.orcamentoId).trim() : '';
                  const eBareOrc = eOrcId.replace(/^orc_/, '');

                  if (id && eId && id === eId) return true;
                  if (fupId && eFupId && fupId === eFupId) return true;
                  if (bareOrc && eBareOrc && bareOrc === eBareOrc) return true;
                  if (fupId && eOrcId && (fupId === eOrcId || fupId === `fup_${eBareOrc}`)) return true;
                  if (orcId && eFupId && (eFupId === orcId || eFupId === `fup_${bareOrc}`)) return true;

                  const ePed = existing.pedido ? String(existing.pedido).replace(/^#+/, '').trim() : '';
                  const eCli = (existing.cliente || existing.clientName || '').trim().toLowerCase();
                  const bothHaveDiffOrcs = Boolean(bareOrc && eBareOrc && bareOrc !== eBareOrc);
                  if (!bothHaveDiffOrcs && cleanPed && ePed && cleanPed === ePed && clientNorm && eCli && clientNorm === eCli) {
                    return true;
                  }
                  return false;
                });
              };

              for (const p of parsedData) {
                if (!p) continue;
                const idx = findMatchingSaleIdx(p);
                if (idx < 0) salesList.push(p);
              }

              for (const loc of [...localList, ...pendingItems]) {
                if (!loc) continue;
                const idx = findMatchingSaleIdx(loc);
                if (idx < 0) {
                  salesList.push(loc);
                } else {
                  const existing = salesList[idx];
                  const existingTs = new Date(existing.updatedAt || existing.dataAtualizacao || 0).getTime() || 0;
                  const locTs = new Date(loc.updatedAt || loc.dataAtualizacao || 0).getTime() || 0;
                  if (locTs > existingTs) {
                    salesList[idx] = { ...existing, ...loc, id: existing.id || loc.id };
                  }
                }
              }
              finalData = salesList;
            } else if (key === 'fenix_followup_cards_v2') {
              finalData = mergeFollowUpArraysSafe(parsedData, [...localList, ...pendingItems]);
            } else {
              const map = new Map<string, any>();
              for (const p of parsedData) {
                if (!p) continue;
                const pId = String(p.id ?? p.idOrcamento ?? p.codigo ?? p._id ?? p.pedido ?? '').trim();
                if (pId) map.set(pId, p);
                else map.set(`rem_${Math.random()}`, p);
              }
              for (const p of pendingItems) {
                if (!p) continue;
                const pId = String(p.id ?? p.idOrcamento ?? p.codigo ?? p._id ?? p.pedido ?? '').trim();
                if (pId && !map.has(pId)) map.set(pId, p);
              }
              finalData = Array.from(map.values());
            }
          } else {
            finalData = parsedData;
          }
        }

        const stringVal = typeof finalData === 'string' ? finalData : JSON.stringify(finalData);
        if (currentLocalRaw !== stringVal) {
          setLocalCollectionSafe(key, stringVal);
          pulledCount++;
          dispatchCollectionEvents(key);
        }
      } catch (storageErr) {
        console.error(`Erro ao gravar ${key} no cache/storage:`, storageErr);
      }
    }

    currentSyncStatus.connected = true;
    currentSyncStatus.lastSyncTime = new Date().toLocaleTimeString('pt-BR');
    currentSyncStatus.error = failedKeys.length > 0 ? `Algumas coleções falharam: ${failedKeys.join(', ')}` : null;
    currentSyncStatus.isSyncing = false;
    notifyStatus();

    drainPendingSyncQueue().catch(() => {});

    return {
      success: failedKeys.length === 0,
      pulledCount,
      ...(failedKeys.length > 0 ? { error: currentSyncStatus.error || undefined } : {}),
    };
  } catch (err: any) {
    const errorMsg = err?.message || 'Não foi possível carregar os dados. Operando com dados locais.';
    currentSyncStatus.isSyncing = false;
    currentSyncStatus.error = errorMsg;
    notifyStatus();
    return { success: false, pulledCount: 0, error: errorMsg };
  }
}

/**
 * Saves a single item into a collection stored in Supabase fenix_kv_store.
 * - Concurrency protection: fetches current remote records first.
 * - Merge seguro com base local e remota sem perder registros.
 * - Automatic retry with exponential backoff on transient errors.
 * - Fila offline automática em caso de desconexão.
 */
export async function saveItemToSupabase<T extends Record<string, any>>(
  collectionKey: string,
  item: T,
  idFieldOrUser = 'id',
  currentUser?: string
): Promise<{ success: boolean; data?: T; error?: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Não foi possível salvar. Verifique sua conexão e tente novamente.',
    };
  }

  // Resolve idField vs currentUser defensivamente
  let idField = 'id';
  let resolvedUser = currentUser;

  if (currentUser === undefined) {
    if (idFieldOrUser && idFieldOrUser !== 'id' && idFieldOrUser !== '_id' && !(idFieldOrUser in item)) {
      resolvedUser = idFieldOrUser;
      idField = 'id';
    } else {
      idField = idFieldOrUser || 'id';
    }
  } else {
    idField = idFieldOrUser || 'id';
  }

  const user = resolvedUser || localStorage.getItem('fenix_active_user_name') || localStorage.getItem('fenix_saved_username') || 'Usuário Fênix';

  // Garante que o item possua um identificador válido
  let itemId = (item as any)[idField] ?? (item as any).id ?? (item as any)._id ?? (item as any).idOrcamento ?? (item as any).pedido;
  if (itemId === undefined || itemId === null || String(itemId).trim() === '') {
    itemId = `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    (item as any)[idField] = itemId;
  }

  try {
    return await executeWithRetry(async () => {
      // 1. Busca estado remoto oficial atual da coleção diretamente no Supabase
      const { data: remoteRow, error: fetchErr } = await client
        .from('fenix_kv_store')
        .select('data')
        .eq('key', collectionKey)
        .maybeSingle();

      if (fetchErr) {
        throw fetchErr;
      }

      let remoteList: T[] = [];
      if (remoteRow && remoteRow.data !== undefined) {
        let rData = remoteRow.data;
        if (typeof rData === 'string') {
          try {
            rData = JSON.parse(rData);
          } catch {}
        }
        if (Array.isArray(rData)) {
          remoteList = rData;
        }
      }

      // 2. Lê estado local/memória atual como complemento defensivo
      const localList: T[] = getLocalCollectionSafe<T>(collectionKey, []);

      // 3. Mescla com precedência total da base oficial do Supabase
      const baseMap = new Map<string, any>();
      for (const rem of remoteList) {
        if (!rem) continue;
        const rId = String(rem[idField] ?? rem.id ?? rem._id ?? rem.idOrcamento ?? rem.pedido ?? '').trim();
        if (rId) baseMap.set(rId, rem);
      }
      // Adiciona itens locais apenas se ainda não constarem no Supabase
      for (const loc of localList) {
        if (!loc) continue;
        const lId = String(loc[idField] ?? loc.id ?? loc._id ?? loc.idOrcamento ?? loc.pedido ?? '').trim();
        if (lId && !baseMap.has(lId)) {
          baseMap.set(lId, loc);
        }
      }
      const cleanBaseList: T[] = deduplicateListById(Array.from(baseMap.values()), idField);

      // 4. Atualiza ou insere o item com correspondência rigorosa de ID e chaves de vínculo (1:1 Follow-up / Metas)
      const cleanItemId = String(itemId).trim();
      const itemOrcId = (item as any).orcamentoId ? String((item as any).orcamentoId).trim() : '';
      const itemFupId = (item as any).followUpId ? String((item as any).followUpId).trim() : '';
      const itemPed = (item as any).pedido ? String((item as any).pedido).replace(/^#+/, '').trim() : '';
      const itemCli = ((item as any).cliente || (item as any).clientName || '').trim().toLowerCase();

      const existingIndex = cleanBaseList.findIndex((x: any) => {
        if (!x) return false;
        const xId = String(x[idField] ?? x.id ?? x._id ?? x.idOrcamento ?? x.pedido ?? '').trim();
        if (xId === cleanItemId) return true;

        if (collectionKey === 'fenix_followup_cards_v2' && itemOrcId) {
          const itemBareOrc = itemOrcId.replace(/^orc_/, '');
          const xOrcId = x.orcamentoId ? String(x.orcamentoId).trim() : '';
          const xBareOrc = xOrcId.replace(/^orc_/, '');
          if (xOrcId && (xOrcId === itemOrcId || (itemBareOrc && xBareOrc === itemBareOrc))) return true;
          if (xId === `fup_${itemOrcId}` || xId === itemOrcId || (itemBareOrc && (xId === `fup_${itemBareOrc}` || xId === itemBareOrc || xId === `fup_orc_${itemBareOrc}`))) return true;
        }

        if (collectionKey === 'fenix_metas_sales_db') {
          const itemBareOrc = itemOrcId.replace(/^orc_/, '');
          const xFupId = x.followUpId ? String(x.followUpId).trim() : '';
          const xOrcId = x.orcamentoId ? String(x.orcamentoId).trim() : '';
          const xBareOrc = xOrcId.replace(/^orc_/, '');
          if (itemFupId && (xFupId === itemFupId || xOrcId === itemFupId || xId === `v_orc_${itemFupId}`)) return true;
          if (itemOrcId && (xOrcId === itemOrcId || (itemBareOrc && xBareOrc === itemBareOrc) || xFupId === `fup_${itemOrcId}` || xId === `v_orc_${itemOrcId}` || (itemBareOrc && xId === `v_orc_${itemBareOrc}`))) return true;
          const xPed = x.pedido ? String(x.pedido).replace(/^#+/, '').trim() : '';
          const xCli = (x.cliente || x.clientName || '').trim().toLowerCase();
          const bothHaveDiffOrcs = Boolean(itemBareOrc && xBareOrc && itemBareOrc !== xBareOrc);
          if (!bothHaveDiffOrcs && itemPed && xPed && itemPed === xPed && (!itemCli || !xCli || itemCli === xCli)) return true;
        }

        return false;
      });

      let updatedList: T[];
      if (existingIndex >= 0) {
        // Atualização em lote preservando o registro existente e seu ID canônico
        const existingItem = cleanBaseList[existingIndex] as any;
        const canonicalId = existingItem[idField] ?? itemId;
        const updatedItem = {
          ...existingItem,
          ...item,
          [idField]: canonicalId,
          updatedAt: (item as any).updatedAt || new Date().toISOString(),
        };
        updatedList = cleanBaseList.map((x: any, idx: number) => {
          if (idx === existingIndex) {
            return updatedItem;
          }
          return x;
        });
      } else {
        // Inserção de novo registro
        updatedList = [item, ...cleanBaseList];
      }

      // Proteção anti-perda: lista nunca pode ficar vazia se havia dados existentes
      if (cleanBaseList.length > 0 && updatedList.length === 0) {
        throw new Error('Falha de integridade: a lista não pode ser esvaziada durante o salvamento.');
      }

      const nowIso = new Date().toISOString();
      recordSelfSave(collectionKey, nowIso);

      // 5. Upsert no Supabase com confirmação
      const { error: upsertErr } = await client
        .from('fenix_kv_store')
        .upsert(
          {
            key: collectionKey,
            data: updatedList,
            updated_at: nowIso,
            updated_by: user,
          },
          { onConflict: 'key' }
        );

      if (upsertErr) {
        throw upsertErr;
      }

      // 6. Confirmação do Supabase: atualiza cache em memória + localStorage seguro e notifica componentes
      setLocalCollectionSafe(collectionKey, updatedList);
      dispatchCollectionEvents(collectionKey);

      return {
        success: true,
        data: existingIndex >= 0 ? updatedList[existingIndex] : item,
      };
    });
  } catch (err: any) {
    console.error(`Erro ao salvar item em ${collectionKey} no Supabase:`, err);
    // Salva na fila offline para preservar a digitação do usuário em caso de queda de rede
    queuePendingItem(collectionKey, item, idField, user);

    const errorMessage =
      err?.message ||
      err?.error_description ||
      (typeof err === 'string' ? err : 'Não foi possível salvar no banco de dados Supabase.');

    return {
      success: false,
      error: errorMessage,
      data: item,
    };
  }
}

/**
 * Deletes a single item from a collection in Supabase fenix_kv_store.
 * - Concurrency protection: fetches current remote records first.
 * - Remove estritamente o item correspondente pelo ID, preservando todos os demais.
 * - Automatic retry with exponential backoff on transient errors.
 */
export async function deleteItemFromSupabase(
  collectionKey: string,
  itemId: string | number,
  idFieldOrUser = 'id',
  currentUser?: string
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Não foi possível salvar. Verifique sua conexão e tente novamente.',
    };
  }

  // Resolve idField vs currentUser defensivamente
  let idField = 'id';
  let resolvedUser = currentUser;

  if (currentUser === undefined) {
    if (idFieldOrUser && idFieldOrUser !== 'id' && idFieldOrUser !== '_id') {
      resolvedUser = idFieldOrUser;
      idField = 'id';
    } else {
      idField = idFieldOrUser || 'id';
    }
  } else {
    idField = idFieldOrUser || 'id';
  }

  const user = resolvedUser || (typeof localStorage !== 'undefined' ? (localStorage.getItem('fenix_active_user_name') || localStorage.getItem('fenix_saved_username')) : null) || 'Usuário Fênix';

  return executeWithRetry(async () => {
    const { data: remoteRow, error: fetchErr } = await client
      .from('fenix_kv_store')
      .select('data')
      .eq('key', collectionKey)
      .maybeSingle();

    if (fetchErr) {
      throw fetchErr;
    }

    let remoteList: any[] = [];
    if (remoteRow && remoteRow.data !== undefined) {
      let rData = remoteRow.data;
      if (typeof rData === 'string') {
        try {
          rData = JSON.parse(rData);
        } catch {}
      }
      if (Array.isArray(rData)) {
        remoteList = rData;
      }
    }

    const localList: any[] = getLocalCollectionSafe(collectionKey, []);

    const baseMap = new Map<string, any>();
    for (const rem of remoteList) {
      if (!rem) continue;
      const rId = String(rem[idField] ?? rem.id ?? rem._id ?? rem.idOrcamento ?? rem.pedido ?? '').trim();
      if (rId) baseMap.set(rId, rem);
    }
    for (const loc of localList) {
      if (!loc) continue;
      const lId = String(loc[idField] ?? loc.id ?? loc._id ?? loc.idOrcamento ?? loc.pedido ?? '').trim();
      if (lId && !baseMap.has(lId)) baseMap.set(lId, loc);
    }
    const baseList = deduplicateListById(Array.from(baseMap.values()), idField);
    const cleanDeleteId = String(itemId).trim();
    const updatedList = baseList.filter((x: any) => {
      if (!x) return false;
      const xId = String(x[idField] ?? x.id ?? x._id ?? x.idOrcamento ?? x.pedido ?? '').trim();
      return xId !== cleanDeleteId;
    });

    const nowIso = new Date().toISOString();
    recordSelfSave(collectionKey, nowIso);

    const { error: upsertErr } = await client
      .from('fenix_kv_store')
      .upsert(
        {
          key: collectionKey,
          data: updatedList,
          updated_at: nowIso,
          updated_by: user,
        },
        { onConflict: 'key' }
      );

    if (upsertErr) {
      throw upsertErr;
    }

    setLocalCollectionSafe(collectionKey, updatedList);
    dispatchCollectionEvents(collectionKey);

    return { success: true };
  }).catch((err) => {
    console.error(`Erro ao excluir de ${collectionKey} no Supabase:`, err);
    return {
      success: false,
      error: err?.message || 'Não foi possível excluir o item do banco de dados.',
    };
  });
}

/**
 * Saves a whole collection payload into Supabase fenix_kv_store with ANTI-WIPE GUARD.
 * 1. Anti-wipe: blocks empty array overwrites if collection currently has data.
 * 2. Deduplicates items strictly by ID.
 * 3. Automatic retry for transient database errors.
 * 4. Updates local cache only upon Supabase confirmation.
 */
export async function saveWholeCollectionToSupabase(
  collectionKey: string,
  data: any,
  currentUser?: string
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Não foi possível salvar. Verifique sua conexão e tente novamente.',
    };
  }

  const user = currentUser || localStorage.getItem('fenix_active_user_name') || localStorage.getItem('fenix_saved_username') || 'Usuário Fênix';

  // 1. ANTI-WIPE PROTECTION (local + memória):
  if (Array.isArray(data) && data.length === 0) {
    const existingLocal = getLocalCollectionSafe(collectionKey, []);
    if (existingLocal.length > 0) {
      console.warn(`[ANTI-WIPE] Bloqueada tentativa de sobrescrever ${collectionKey} com array vazio (${existingLocal.length} itens preservados).`);
      return { success: false, error: 'Operação bloqueada por segurança: dados existentes não podem ser apagados em lote.' };
    }
  }

  return executeWithRetry(async () => {
    let dataToSave = Array.isArray(data) ? deduplicateListById(data) : data;

    // 2. PROTEÇÃO REMOTA UNIVERSAL ANTI-TRUNCAMENTO para coleções críticas do CRM:
    // Consulta o Supabase antes de gravar e faz merge preservando todos os registros remotos existentes.
    if (PROTECTED_MERGE_COLLECTIONS.has(collectionKey) && Array.isArray(data)) {
      const { data: remoteRow, error: fetchErr } = await client
        .from('fenix_kv_store')
        .select('data')
        .eq('key', collectionKey)
        .maybeSingle();

      if (fetchErr) {
        throw fetchErr;
      }

      let remoteList: any[] = [];
      if (remoteRow && remoteRow.data !== undefined) {
        let rData = remoteRow.data;
        if (typeof rData === 'string') {
          try {
            rData = JSON.parse(rData);
          } catch {}
        }
        if (Array.isArray(rData)) {
          remoteList = rData;
        }
      }

      if (remoteList.length > 0 && data.length === 0) {
        throw new Error(`[ANTI-WIPE] Bloqueada sobrescrita vazia em ${collectionKey} (${remoteList.length} registros remotos preservados).`);
      }

      if (remoteList.length > 0) {
        if (collectionKey === 'fenix_metas_sales_db') {
          const mergedSales: any[] = [];
          const findIdx = (candidate: any): number => {
            const id = String(candidate.id || '').trim();
            const fupId = candidate.followUpId ? String(candidate.followUpId).trim() : '';
            const orcId = candidate.orcamentoId ? String(candidate.orcamentoId).trim() : '';
            const bareOrc = orcId.replace(/^orc_/, '');
            const cleanPed = candidate.pedido ? String(candidate.pedido).replace(/^#+/, '').trim() : '';
            const clientNorm = (candidate.cliente || candidate.clientName || '').trim().toLowerCase();

            return mergedSales.findIndex((existing) => {
              const eId = String(existing.id || '').trim();
              const eFupId = existing.followUpId ? String(existing.followUpId).trim() : '';
              const eOrcId = existing.orcamentoId ? String(existing.orcamentoId).trim() : '';
              const eBareOrc = eOrcId.replace(/^orc_/, '');

              if (id && eId && id === eId) return true;
              if (fupId && eFupId && fupId === eFupId) return true;
              if (bareOrc && eBareOrc && bareOrc === eBareOrc) return true;
              if (fupId && eOrcId && (fupId === eOrcId || fupId === `fup_${eBareOrc}`)) return true;
              if (orcId && eFupId && (eFupId === orcId || eFupId === `fup_${bareOrc}`)) return true;

              const ePed = existing.pedido ? String(existing.pedido).replace(/^#+/, '').trim() : '';
              const eCli = (existing.cliente || existing.clientName || '').trim().toLowerCase();
              const bothHaveDiffOrcs = Boolean(bareOrc && eBareOrc && bareOrc !== eBareOrc);
              if (!bothHaveDiffOrcs && cleanPed && ePed && cleanPed === ePed && clientNorm && eCli && clientNorm === eCli) {
                return true;
              }
              return false;
            });
          };

          remoteList.forEach((s: any) => {
            if (!s) return;
            if (findIdx(s) < 0) mergedSales.push(s);
          });

          data.forEach((s: any) => {
            if (!s) return;
            const idx = findIdx(s);
            if (idx < 0) {
              mergedSales.push(s);
            } else {
              const existing = mergedSales[idx];
              const existingTs = new Date(existing.updatedAt || existing.dataAtualizacao || 0).getTime() || 0;
              const incomingTs = new Date(s.updatedAt || s.dataAtualizacao || 0).getTime() || 0;
              if (incomingTs >= existingTs) {
                mergedSales[idx] = { ...existing, ...s, id: existing.id || s.id };
              }
            }
          });

          dataToSave = mergedSales;
        } else if (collectionKey === 'fenix_followup_cards_v2') {
          dataToSave = mergeFollowUpArraysSafe(remoteList, data);
        } else {
          dataToSave = safeMergeLists(remoteList, data, 'id');
        }
      }
    }

    const nowIso = new Date().toISOString();
    recordSelfSave(collectionKey, nowIso);

    const { error: upsertErr } = await client
      .from('fenix_kv_store')
      .upsert(
        {
          key: collectionKey,
          data: dataToSave,
          updated_at: nowIso,
          updated_by: user,
        },
        { onConflict: 'key' }
      );

    if (upsertErr) {
      throw upsertErr;
    }

    setLocalCollectionSafe(collectionKey, dataToSave);
    dispatchCollectionEvents(collectionKey);

    return { success: true };
  }).catch((err) => {
    console.error(`Erro ao salvar ${collectionKey} no Supabase:`, err);
    return {
      success: false,
      error: err?.message || 'Não foi possível salvar. Verifique sua conexão e tente novamente.',
    };
  });
}
