import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  Layers,
  RefreshCw,
  Scale,
  Target,
  UserCheck,
  Users,
} from 'lucide-react';
import { getSupabaseClient } from '../../utils/supabaseClient';
import {
  SimuladorClienteOrcamento,
  SimuladorEstrategiaKey,
  SimuladorPeriodoKey,
  SimuladorSupabasePayload,
  calcularEstrategiasFechamento,
  fetchSimuladorDataFromSupabase,
} from '../../utils/simuladorFechamento';

export interface SimuladorFechamentoProps {
  currentUserName: string;
  selectedDate: Date;
  onNavigateTab?: (tab: string) => void;
}

const INITIAL_VISIBLE_CLIENTS = 3;

const formatCurrency = (val?: number | null): string => {
  const num = typeof val === 'number' && Number.isFinite(val) ? val : 0;
  return num.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
};

const formatPercent = (val?: number | null): string => {
  const num = typeof val === 'number' && Number.isFinite(val) ? val : 0;
  return `${num.toFixed(1).replace('.', ',')}%`;
};

const PERIOD_ORDER: SimuladorPeriodoKey[] = ['hoje', 'semana', 'mes'];

const PERIOD_META_CONFIG: Record<
  SimuladorPeriodoKey,
  {
    headerLabel: string;
    metaLabel: string;
    soldLabel: string;
    topBarClass: string;
    titleColorClass: string;
    soldColorClass: string;
    progressBarClass: string;
    percentColorClass: string;
    selectedCardClass: string;
    unselectedCardClass: string;
    selectedIconClass: string;
    unselectedIconClass: string;
    selectedTagClass: string;
    Icon: React.ComponentType<{ className?: string }>;
  }
> = {
  hoje: {
    headerLabel: 'VENDA DE HOJE',
    metaLabel: 'Meta diária',
    soldLabel: 'Valor vendido',
    topBarClass: 'bg-emerald-600',
    titleColorClass: 'text-emerald-700',
    soldColorClass: 'text-emerald-600',
    progressBarClass: 'bg-emerald-500',
    percentColorClass: 'text-emerald-700',
    selectedCardClass: 'border-2 border-emerald-500 shadow-sm ring-2 ring-emerald-500/15',
    unselectedCardClass: 'border border-slate-200/90 hover:border-emerald-300 shadow-2xs hover:shadow-xs',
    selectedIconClass: 'bg-emerald-600 text-white',
    unselectedIconClass: 'bg-emerald-50 text-emerald-600',
    selectedTagClass: 'text-emerald-600',
    Icon: Clock,
  },
  semana: {
    headerLabel: 'VENDA DA SEMANA',
    metaLabel: 'Meta semanal',
    soldLabel: 'Valor vendido',
    topBarClass: 'bg-[#0052cc]',
    titleColorClass: 'text-[#0052cc]',
    soldColorClass: 'text-[#0052cc]',
    progressBarClass: 'bg-[#0052cc]',
    percentColorClass: 'text-[#0052cc]',
    selectedCardClass: 'border-2 border-[#0052cc] shadow-sm ring-2 ring-[#0052cc]/15',
    unselectedCardClass: 'border border-slate-200/90 hover:border-blue-300 shadow-2xs hover:shadow-xs',
    selectedIconClass: 'bg-[#0052cc] text-white',
    unselectedIconClass: 'bg-blue-50 text-[#0052cc]',
    selectedTagClass: 'text-[#0052cc]',
    Icon: CalendarDays,
  },
  mes: {
    headerLabel: 'META DO MÊS',
    metaLabel: 'Meta mensal',
    soldLabel: 'Total faturado',
    topBarClass: 'bg-[#7C3AED]',
    titleColorClass: 'text-[#7C3AED]',
    soldColorClass: 'text-[#7C3AED]',
    progressBarClass: 'bg-[#7C3AED]',
    percentColorClass: 'text-[#7C3AED]',
    selectedCardClass: 'border-2 border-[#7C3AED] shadow-sm ring-2 ring-[#7C3AED]/15',
    unselectedCardClass: 'border border-slate-200/90 hover:border-purple-300 shadow-2xs hover:shadow-xs',
    selectedIconClass: 'bg-[#7C3AED] text-white',
    unselectedIconClass: 'bg-purple-50 text-[#7C3AED]',
    selectedTagClass: 'text-[#7C3AED]',
    Icon: Target,
  },
};

const STRATEGY_ORDER: SimuladorEstrategiaKey[] = [
  'menos_clientes',
  'equilibrada',
  'mais_oportunidades',
];

const STRATEGY_THEME: Record<
  SimuladorEstrategiaKey,
  {
    headerBgClass: string;
    cardBorderClass: string;
    iconBoxClass: string;
    metricBlockClass: string;
    followUpBtnClass: string;
    expandBarClass: string;
    Icon: React.ComponentType<{ className?: string }>;
  }
> = {
  menos_clientes: {
    headerBgClass: 'bg-[#0B2046]',
    cardBorderClass: 'border-slate-200/90',
    iconBoxClass: 'bg-white/15 border border-white/20 text-white',
    metricBlockClass: 'bg-white/10 border border-white/20',
    followUpBtnClass: 'bg-[#0B2046] hover:bg-[#13326b] text-white focus-visible:outline-[#0B2046]',
    expandBarClass:
      'bg-slate-50/80 hover:bg-slate-100 text-[#0B2046] border-t border-slate-200/80',
    Icon: UserCheck,
  },
  equilibrada: {
    headerBgClass: 'bg-gradient-to-r from-[#6D28D9] to-[#7C3AED]',
    cardBorderClass: 'border-purple-200/80',
    iconBoxClass: 'bg-white/15 border border-white/25 text-white',
    metricBlockClass: 'bg-white/12 border border-white/25',
    followUpBtnClass: 'bg-[#7C3AED] hover:bg-[#6D28D9] text-white focus-visible:outline-[#7C3AED]',
    expandBarClass:
      'bg-purple-50/45 hover:bg-purple-50 text-[#6D28D9] border-t border-purple-100',
    Icon: Scale,
  },
  mais_oportunidades: {
    headerBgClass: 'bg-gradient-to-r from-[#0052cc] to-[#1D4ED8]',
    cardBorderClass: 'border-blue-200/80',
    iconBoxClass: 'bg-white/15 border border-white/25 text-white',
    metricBlockClass: 'bg-white/12 border border-white/25',
    followUpBtnClass: 'bg-[#0052cc] hover:bg-[#0041a8] text-white focus-visible:outline-[#0052cc]',
    expandBarClass:
      'bg-blue-50/45 hover:bg-blue-50 text-[#0052cc] border-t border-blue-100',
    Icon: Users,
  },
};

export const SimuladorFechamento: React.FC<SimuladorFechamentoProps> = ({
  currentUserName,
  selectedDate,
  onNavigateTab,
}) => {
  const [selectedPeriodo, setSelectedPeriodo] = useState<SimuladorPeriodoKey>('mes');
  const [expandedStrategies, setExpandedStrategies] = useState<
    Record<SimuladorEstrategiaKey, boolean>
  >({
    menos_clientes: false,
    equilibrada: false,
    mais_oportunidades: false,
  });

  const [payload, setPayload] = useState<SimuladorSupabasePayload | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const loadFromSupabase = useCallback(
    async (silent = false) => {
      if (silent) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      const result = await fetchSimuladorDataFromSupabase(currentUserName, selectedDate);
      setPayload(result);
      setIsLoading(false);
      setIsRefreshing(false);
    },
    [currentUserName, selectedDate]
  );

  // Carrega diretamente do Supabase e mantém sincronização em tempo real entre desktop e celular
  useEffect(() => {
    loadFromSupabase(false);

    const handleRefreshEvent = () => {
      loadFromSupabase(true);
    };

    window.addEventListener('fenix_metas_updated', handleRefreshEvent);
    window.addEventListener('fenix_metas_config_updated', handleRefreshEvent);
    window.addEventListener('fenix_followup_updated', handleRefreshEvent);
    window.addEventListener('fenix_orcamentos_updated', handleRefreshEvent);
    window.addEventListener('fenix_vendas_updated', handleRefreshEvent);
    window.addEventListener('fenix_clients_updated', handleRefreshEvent);
    window.addEventListener('focus', handleRefreshEvent);

    const client = getSupabaseClient();
    const channel = client
      ? client
          .channel(`simulador_fechamento_${currentUserName.replace(/\s+/g, '_').toLowerCase()}`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'fenix_kv_store' },
            (change: any) => {
              const key = change?.new?.key;
              if (
                key === 'fenix_metas_sales_db' ||
                key === 'fenix_followup_cards_v2' ||
                key === 'fenix_orcamentos_history' ||
                key === 'fenix_saved_orcamentos' ||
                key === 'fenix_clients_db' ||
                key === 'fenix_individual_metas_map' ||
                key === 'fenix_metas_config_data' ||
                key === 'fenix_deleted_vendas_ids'
              ) {
                loadFromSupabase(true);
              }
            }
          )
          .subscribe()
      : null;

    return () => {
      window.removeEventListener('fenix_metas_updated', handleRefreshEvent);
      window.removeEventListener('fenix_metas_config_updated', handleRefreshEvent);
      window.removeEventListener('fenix_followup_updated', handleRefreshEvent);
      window.removeEventListener('fenix_orcamentos_updated', handleRefreshEvent);
      window.removeEventListener('fenix_vendas_updated', handleRefreshEvent);
      window.removeEventListener('fenix_clients_updated', handleRefreshEvent);
      window.removeEventListener('focus', handleRefreshEvent);
      if (client && channel) {
        try {
          client.removeChannel(channel);
        } catch {
          // ignore
        }
      }
    };
  }, [currentUserName, loadFromSupabase]);

  const activePeriodo = useMemo(() => {
    if (!payload) return null;
    return payload.periodos[selectedPeriodo];
  }, [payload, selectedPeriodo]);

  const estrategias = useMemo(() => {
    if (!payload || !activePeriodo) return null;
    return calcularEstrategiasFechamento(
      activePeriodo.faltaVender,
      payload.orcamentosElegiveis
    );
  }, [payload, activePeriodo]);

  const toggleStrategyExpand = (key: SimuladorEstrategiaKey) => {
    setExpandedStrategies((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleGoToFollowUp = (clienteItem: SimuladorClienteOrcamento) => {
    try {
      sessionStorage.setItem('fenix_target_followup_id', clienteItem.internalTargetId);
      sessionStorage.setItem('fenix_target_followup_client', clienteItem.clientName);
    } catch {
      // ignore
    }

    onNavigateTab?.('Follow-up');

    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('fenix_open_followup_card', {
          detail: {
            followUpId: clienteItem.internalTargetId,
            clientName: clienteItem.clientName,
          },
        })
      );
    }, 80);
  };

  if (isLoading && !payload) {
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[0, 1, 2].map((idx) => (
            <div
              key={idx}
              className="bg-white rounded-2xl border border-slate-200/90 p-4 shadow-xs space-y-3 animate-pulse"
            >
              <div className="flex items-center justify-between">
                <div className="h-3.5 w-28 bg-slate-200 rounded" />
                <div className="w-8 h-8 rounded-xl bg-slate-100" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="h-6 bg-slate-200 rounded" />
                <div className="h-6 bg-slate-100 rounded" />
              </div>
              <div className="h-2 w-full bg-slate-100 rounded-full" />
            </div>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/90 p-6 shadow-xs animate-pulse space-y-3">
          <div className="h-5 w-56 bg-slate-200 rounded" />
          <div className="h-4 w-96 max-w-full bg-slate-100 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* 1. TRÊS CARDS HORIZONTAIS DE INDICADORES (VERDE: HOJE | AZUL: SEMANA | ROXO: MÊS) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 sm:gap-4 items-stretch">
        {PERIOD_ORDER.map((periodKey) => {
          const item = payload?.periodos[periodKey];
          if (!item) return null;

          const cfg = PERIOD_META_CONFIG[periodKey];
          const Icon = cfg.Icon;
          const isSelected = selectedPeriodo === periodKey;
          const progressWidth = Math.min(100, Math.max(0, item.percentualProgresso));
          const isGoalReached = item.faltaVender <= 0 || item.percentualProgresso >= 100;

          return (
            <button
              key={periodKey}
              type="button"
              onClick={() => setSelectedPeriodo(periodKey)}
              aria-pressed={isSelected}
              className={`h-full text-left rounded-2xl bg-white overflow-hidden transition-all duration-150 cursor-pointer flex flex-col focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0052cc] ${
                isSelected ? cfg.selectedCardClass : cfg.unselectedCardClass
              }`}
            >
              {/* Faixa superior de identidade cromática */}
              <div className={`h-1.5 w-full ${cfg.topBarClass}`} />

              <div className="px-4 py-3.5 sm:px-5 sm:py-4 flex-1 flex flex-col justify-between gap-3 w-full">
                {/* Linha superior: Nome do indicador + Ícone */}
                <div className="flex items-center justify-between gap-3 w-full">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={`text-xs font-extrabold tracking-wider uppercase ${cfg.titleColorClass}`}
                      >
                        {cfg.headerLabel}
                      </span>
                      {isSelected && (
                        <span className={`text-[11px] font-bold ${cfg.selectedTagClass}`}>
                          · Em simulação
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-slate-500 font-medium block mt-0.5 truncate">
                      {item.subtitulo}
                    </span>
                  </div>

                  <div
                    className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? cfg.selectedIconClass : cfg.unselectedIconClass
                    }`}
                  >
                    <Icon className="w-4 h-4 stroke-[2.2]" />
                  </div>
                </div>

                {/* Valores lado a lado: Meta correspondente vs Valor vendido */}
                <div className="grid grid-cols-2 gap-3 w-full">
                  <div className="min-w-0">
                    <span className="text-[11px] font-medium text-slate-500 block">
                      {cfg.metaLabel}
                    </span>
                    <span className="text-base sm:text-[17px] font-extrabold text-[#0B2046] tracking-tight tabular-nums block mt-0.5">
                      {formatCurrency(item.valorMeta)}
                    </span>
                  </div>

                  <div className="min-w-0 text-right">
                    <span className="text-[11px] font-medium text-slate-500 block">
                      {cfg.soldLabel}
                    </span>
                    <span
                      className={`text-base sm:text-[17px] font-extrabold tracking-tight tabular-nums block mt-0.5 ${cfg.soldColorClass}`}
                    >
                      {formatCurrency(item.valorVendido)}
                    </span>
                  </div>
                </div>

                {/* Barra de progresso + Percentual atingido */}
                <div className="w-full space-y-1.5">
                  <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${cfg.progressBarClass}`}
                      style={{ width: `${progressWidth}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
                    <span className={`font-bold ${cfg.percentColorClass}`}>
                      {formatPercent(item.percentualProgresso)} atingido
                    </span>
                    <span className="text-slate-500 font-medium">
                      {isGoalReached
                        ? 'Meta atingida'
                        : `Falta ${formatCurrency(item.faltaVender)}`}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Erro de conexão, se houver */}
      {payload?.error && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-xs sm:text-sm text-amber-800 font-medium">
          {payload.error}
        </div>
      )}

      {/* 2. SEÇÃO DE DESTAQUE: SIMULADOR DE FECHAMENTO */}
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-[#0B2046] text-white flex items-center justify-center shrink-0 shadow-2xs">
              <Layers className="w-5 h-5 stroke-[2.1]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-extrabold text-[#0B2046] tracking-tight">
                Simulador de Fechamento
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 mt-0.5 leading-relaxed">
                Combine seus orçamentos do mês para encontrar as melhores possibilidades de atingir sua meta.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => loadFromSupabase(true)}
            disabled={isRefreshing}
            className="self-start sm:self-center inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200/80 text-[#0B2046] text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>{isRefreshing ? 'Atualizando...' : 'Atualizar'}</span>
          </button>
        </div>

        {/* Informação discreta e resumo do alvo selecionado */}
        <div className="mt-4 pt-3.5 border-t border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 text-xs">
          <div className="flex items-start sm:items-center gap-2 text-slate-500 font-medium">
            <Info className="w-3.5 h-3.5 text-[#0052cc] shrink-0 mt-0.5 sm:mt-0" />
            <span>
              As combinações utilizam um orçamento por cliente do mês selecionado, independentemente da data de criação.
            </span>
          </div>

          {activePeriodo && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-slate-600 font-medium tabular-nums shrink-0">
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-[#0B2046]" />
                <span>
                  Base:{' '}
                  <strong className="text-[#0B2046] font-bold">
                    {activePeriodo.titulo}
                  </strong>
                </span>
              </span>
              <span aria-hidden="true" className="text-slate-300">
                ·
              </span>
              <span>
                Falta:{' '}
                <strong className="text-[#0052cc] font-bold">
                  {formatCurrency(activePeriodo.faltaVender)}
                </strong>
              </span>
              <span aria-hidden="true" className="text-slate-300">
                ·
              </span>
              <span>
                {payload?.orcamentosElegiveis.length || 0}{' '}
                {(payload?.orcamentosElegiveis.length || 0) === 1
                  ? 'orçamento elegível'
                  : 'orçamentos elegíveis'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 3. ESTRATÉGIAS DE FECHAMENTO (CABEÇALHOS COLORIDOS DE PONTA A PONTA + BLOCOS DE INDICADORES + ÁREA BRANCA) */}
      {estrategias && (
        <div className="flex flex-col gap-5">
          {STRATEGY_ORDER.map((strategyKey) => {
            const estrategia = estrategias[strategyKey];
            const theme = STRATEGY_THEME[strategyKey];
            const StrategyIcon = theme.Icon;
            const isExpanded = expandedStrategies[strategyKey];
            const visibleClients = isExpanded
              ? estrategia.clientes
              : estrategia.clientes.slice(0, INITIAL_VISIBLE_CLIENTS);
            const additionalCount = Math.max(
              0,
              estrategia.clientes.length - INITIAL_VISIBLE_CLIENTS
            );

            return (
              <section
                key={strategyKey}
                className={`bg-white rounded-2xl border ${theme.cardBorderClass} shadow-sm overflow-hidden`}
              >
                {/* Cabeçalho colorido de ponta a ponta */}
                <div
                  className={`${theme.headerBgClass} text-white px-4 py-4 sm:px-6 sm:py-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4`}
                >
                  {/* Esquerda: Ícone + Nome + Descrição */}
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-xl ${theme.iconBoxClass} flex items-center justify-center shrink-0`}
                    >
                      <StrategyIcon className="w-5 h-5 stroke-[2.1]" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base sm:text-lg font-extrabold tracking-tight text-white">
                        {estrategia.titulo}
                      </h3>
                      <p className="text-xs sm:text-sm text-white/85 mt-0.5 leading-snug">
                        {estrategia.descricao}
                      </p>
                    </div>
                  </div>

                  {/* Direita: Indicadores em blocos destacados */}
                  <div className="grid grid-cols-1 min-[440px]:grid-cols-3 gap-2.5 xl:flex xl:items-stretch xl:gap-3 shrink-0">
                    <div className={`rounded-xl px-3.5 py-2.5 ${theme.metricBlockClass}`}>
                      <span className="text-[11px] font-medium text-white/80 block whitespace-nowrap">
                        Falta para a meta
                      </span>
                      <span className="text-sm sm:text-base font-extrabold text-white tabular-nums block mt-0.5 whitespace-nowrap">
                        {formatCurrency(estrategia.faltaParaMeta)}
                      </span>
                    </div>

                    <div className={`rounded-xl px-3.5 py-2.5 ${theme.metricBlockClass}`}>
                      <span className="text-[11px] font-medium text-white/80 block whitespace-nowrap">
                        Valor total da combinação
                      </span>
                      <span className="text-sm sm:text-base font-extrabold text-white tabular-nums block mt-0.5 whitespace-nowrap">
                        {formatCurrency(estrategia.totalCombinacao)}
                      </span>
                    </div>

                    <div className={`rounded-xl px-3.5 py-2.5 ${theme.metricBlockClass}`}>
                      <span className="text-[11px] font-medium text-white/80 block whitespace-nowrap">
                        Clientes envolvidos
                      </span>
                      <span className="text-sm sm:text-base font-extrabold text-white tabular-nums block mt-0.5 whitespace-nowrap">
                        {estrategia.quantidadeClientes}{' '}
                        {estrategia.quantidadeClientes === 1 ? 'cliente' : 'clientes'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Área branca para listagem dos clientes */}
                {estrategia.faltaParaMeta <= 0 ? (
                  <div className="bg-white px-5 py-5 sm:px-6 flex items-center gap-2.5 text-xs sm:text-sm font-semibold text-emerald-700">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>Meta do período já atingida com as vendas realizadas.</span>
                  </div>
                ) : estrategia.clientes.length === 0 ? (
                  <div className="bg-white px-5 py-6 sm:px-6 text-xs sm:text-sm text-slate-500 font-medium text-center">
                    Nenhum orçamento elegível disponível neste mês para simular.
                  </div>
                ) : (
                  <div className="bg-white">
                    {!estrategia.atingeMeta && (
                      <div className="px-4 py-2.5 sm:px-6 bg-amber-50/75 border-b border-amber-100 text-xs text-amber-800 font-medium tabular-nums">
                        A carteira atual do mês soma {formatCurrency(estrategia.totalCombinacao)} dos{' '}
                        {formatCurrency(estrategia.faltaParaMeta)} necessários para atingir a meta.
                      </div>
                    )}

                    {/* Cabeçalho das colunas no Desktop */}
                    <div className="hidden md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(130px,1fr)_minmax(140px,1fr)_auto] items-center gap-4 px-6 py-2.5 bg-slate-50/75 border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      <span>Cliente</span>
                      <span>Data do orçamento</span>
                      <span className="text-right">Valor do orçamento</span>
                      <span className="text-right min-w-[116px]">Ação</span>
                    </div>

                    {/* Linhas Horizontais de Clientes (1 orçamento por cliente) */}
                    <div className="divide-y divide-slate-100 bg-white">
                      {visibleClients.map((cliente, idx) => (
                        <div
                          key={`${strategyKey}_${cliente.internalTargetId}_${idx}`}
                          className="flex flex-col md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(130px,1fr)_minmax(140px,1fr)_auto] md:items-center gap-3 md:gap-4 px-4 py-3.5 sm:px-6 hover:bg-slate-50/75 transition-colors"
                        >
                          {/* Esquerda: Nome do cliente em destaque + Telefone logo abaixo */}
                          <div className="min-w-0">
                            <p className="text-sm sm:text-[15px] font-bold text-[#0B2046] leading-snug break-words">
                              {cliente.clientName}
                            </p>
                            <p className="text-xs text-slate-500 font-medium mt-0.5 tabular-nums">
                              {cliente.phone || 'Telefone não informado'}
                            </p>
                          </div>

                          {/* No celular: agrupa Data + Valor + Botão sem cortes; no Desktop: colunas alinhadas via md:contents */}
                          <div className="flex flex-wrap items-center justify-between gap-3 md:contents">
                            <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-3 md:contents">
                              <span className="text-xs sm:text-sm text-slate-600 font-medium tabular-nums">
                                {cliente.budgetDateFormatted}
                              </span>

                              <span className="text-sm sm:text-base font-bold text-[#0B2046] tabular-nums md:text-right">
                                {formatCurrency(cliente.valor)}
                              </span>
                            </div>

                            <div className="md:flex md:justify-end">
                              <button
                                type="button"
                                onClick={() => handleGoToFollowUp(cliente)}
                                className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[40px] md:min-h-[36px] rounded-xl text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-2xs focus-visible:outline-2 focus-visible:outline-offset-2 ${theme.followUpBtnClass}`}
                              >
                                <span>Follow-up</span>
                                <ArrowRight className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Faixa inferior de expansão / recolhimento */}
                    {additionalCount > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleStrategyExpand(strategyKey)}
                        className={`w-full px-5 py-3 text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-2 cursor-pointer ${theme.expandBarClass}`}
                      >
                        {isExpanded ? (
                          <>
                            <ChevronUp className="w-4 h-4 shrink-0" />
                            <span>Recolher lista</span>
                          </>
                        ) : (
                          <>
                            <ChevronDown className="w-4 h-4 shrink-0" />
                            <span>
                              +{additionalCount}{' '}
                              {additionalCount === 1
                                ? 'cliente adicional'
                                : 'clientes adicionais'}
                            </span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};
