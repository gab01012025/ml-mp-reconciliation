'use client';

import { format, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { 
  BarChart3, 
  RefreshCw, 
  FileSpreadsheet, 
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  DollarSign,
  Package,
  ArrowRightLeft,
  Calendar,
  Download
} from 'lucide-react';
import { useState, useEffect } from 'react';

interface DashboardStats {
  totalReconciliations: number;
  pendingItems: number;
  matchedItems: number;
  divergentItems: number;
  totalDiscrepancy: number;
  recentReconciliations: Array<{
    id: string;
    periodStart: string;
    periodEnd: string;
    status: string;
    matchedCount: number;
    unmatchedCount: number;
    divergentCount: number;
    discrepancy: number;
    createdAt: string;
  }>;
}

interface SystemMetrics {
  uptime: number;
  uptimeFormatted: string;
  memory: {
    heapUsed: number;
    heapTotal: number;
  };
}

const API_KEY = 'dev-api-key-12345';

async function fetchAPI(endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`/api${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      ...options.headers,
    },
  });
  return res.json();
}

function StatCard({ 
  title, 
  value, 
  icon: Icon, 
  color = 'blue',
  subtitle 
}: { 
  title: string; 
  value: string | number; 
  icon: React.ElementType; 
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
  subtitle?: string;
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600 border-blue-100',
    green: 'bg-green-50 text-green-600 border-green-100',
    yellow: 'bg-yellow-50 text-yellow-600 border-yellow-100',
    red: 'bg-red-50 text-red-600 border-red-100',
    gray: 'bg-gray-50 text-gray-600 border-gray-100',
  };

  return (
    <div className={`rounded-xl border p-6 ${colors[color]}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium opacity-80">{title}</p>
          <p className="mt-1 text-3xl font-bold">{value}</p>
          {subtitle && <p className="mt-1 text-xs opacity-60">{subtitle}</p>}
        </div>
        <Icon className="h-10 w-10 opacity-40" />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    MATCHED: 'bg-green-100 text-green-800',
    PENDING: 'bg-yellow-100 text-yellow-800',
    DIVERGENT: 'bg-red-100 text-red-800',
    UNMATCHED: 'bg-orange-100 text-orange-800',
    RESOLVED: 'bg-blue-100 text-blue-800',
  };

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-800'}`}>
      {status}
    </span>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [dateRange, setDateRange] = useState({
    start: format(subDays(new Date(), 30), 'yyyy-MM-dd'),
    end: format(new Date(), 'yyyy-MM-dd'),
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [dashboardRes, metricsRes] = await Promise.all([
        fetchAPI('/reconciliation/dashboard'),
        fetchAPI('/metrics/system'),
      ]);
      
      if (dashboardRes.success) setStats(dashboardRes.data);
      if (metricsRes.success) setMetrics(metricsRes.data);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error loading data:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      // Sync ML orders
      await fetchAPI('/sync/ml/orders', {
        method: 'POST',
        body: JSON.stringify({
          startDate: dateRange.start,
          endDate: dateRange.end,
        }),
      });
      
      // Sync MP movements
      await fetchAPI('/sync/mp/movements', {
        method: 'POST',
        body: JSON.stringify({
          startDate: dateRange.start,
          endDate: dateRange.end,
        }),
      });
      
      await loadData();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Sync error:', error);
    }
    setSyncing(false);
  };

  const handleReconcile = async () => {
    setReconciling(true);
    try {
      await fetchAPI(`/reconciliation/run?periodStart=${dateRange.start}&periodEnd=${dateRange.end}`, {
        method: 'POST',
      });
      await loadData();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Reconciliation error:', error);
    }
    setReconciling(false);
  };

  const handleExport = async (type: 'orders' | 'movements' | 'reconciliation') => {
    try {
      const res = await fetch(
        `/api/reports/export/${type}?startDate=${dateRange.start}&endDate=${dateRange.end}`,
        {
          headers: { 'x-api-key': API_KEY },
        }
      );
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type}_${dateRange.start}_${dateRange.end}.csv`;
      a.click();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Export error:', error);
    }
  };

  if (loading && !stats) {
    return (
      <div className="flex h-screen items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <ArrowRightLeft className="h-8 w-8 text-blue-600" />
              <div>
                <h1 className="text-xl font-bold text-gray-900">ML-MP Conciliação</h1>
                <p className="text-sm text-gray-500">Sistema de Conciliação Financeira</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-4">
              {metrics && (
                <span className="text-sm text-gray-500">
                  Uptime: {metrics.uptimeFormatted}
                </span>
              )}
              <button
                onClick={loadData}
                className="rounded-lg bg-gray-100 p-2 text-gray-600 hover:bg-gray-200"
              >
                <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Date Range & Actions */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-white p-4 shadow-sm">
          <div className="flex items-center space-x-4">
            <Calendar className="h-5 w-5 text-gray-400" />
            <div className="flex items-center space-x-2">
              <input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                className="rounded-lg border px-3 py-2 text-sm"
              />
              <span className="text-gray-400">até</span>
              <input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                className="rounded-lg border px-3 py-2 text-sm"
              />
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center space-x-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Sincronizando...' : 'Sincronizar'}</span>
            </button>
            
            <button
              onClick={handleReconcile}
              disabled={reconciling}
              className="flex items-center space-x-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              <BarChart3 className={`h-4 w-4 ${reconciling ? 'animate-spin' : ''}`} />
              <span>{reconciling ? 'Processando...' : 'Reconciliar'}</span>
            </button>
            
            <div className="relative">
              <button className="flex items-center space-x-2 rounded-lg bg-gray-600 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700">
                <Download className="h-4 w-4" />
                <span>Exportar</span>
              </button>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Total Conciliações"
            value={stats?.totalReconciliations || 0}
            icon={FileSpreadsheet}
            color="blue"
          />
          <StatCard
            title="Itens Conciliados"
            value={stats?.matchedItems || 0}
            icon={CheckCircle2}
            color="green"
            subtitle="Matches confirmados"
          />
          <StatCard
            title="Pendentes"
            value={stats?.pendingItems || 0}
            icon={Clock}
            color="yellow"
            subtitle="Aguardando revisão"
          />
          <StatCard
            title="Divergentes"
            value={stats?.divergentItems || 0}
            icon={AlertTriangle}
            color="red"
            subtitle={`R$ ${(stats?.totalDiscrepancy || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`}
          />
        </div>

        {/* Quick Actions */}
        <div className="mb-8 grid gap-4 sm:grid-cols-3">
          <button
            onClick={() => handleExport('orders')}
            className="flex items-center justify-center space-x-2 rounded-xl border bg-white p-6 shadow-sm transition hover:border-blue-300 hover:shadow-md"
          >
            <Package className="h-6 w-6 text-blue-600" />
            <span className="font-medium">Exportar Pedidos ML</span>
          </button>
          
          <button
            onClick={() => handleExport('movements')}
            className="flex items-center justify-center space-x-2 rounded-xl border bg-white p-6 shadow-sm transition hover:border-green-300 hover:shadow-md"
          >
            <DollarSign className="h-6 w-6 text-green-600" />
            <span className="font-medium">Exportar Movimentos MP</span>
          </button>
          
          <button
            onClick={() => handleExport('reconciliation')}
            className="flex items-center justify-center space-x-2 rounded-xl border bg-white p-6 shadow-sm transition hover:border-purple-300 hover:shadow-md"
          >
            <FileSpreadsheet className="h-6 w-6 text-purple-600" />
            <span className="font-medium">Exportar Conciliação</span>
          </button>
        </div>

        {/* Recent Reconciliations */}
        <div className="rounded-xl bg-white shadow-sm">
          <div className="border-b px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Conciliações Recentes</h2>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Período
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Status
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Conciliados
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Pendentes
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Divergentes
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    Discrepância
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {stats?.recentReconciliations?.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      Nenhuma conciliação encontrada. Execute uma sincronização e conciliação.
                    </td>
                  </tr>
                ) : (
                  stats?.recentReconciliations?.map((rec) => (
                    <tr key={rec.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="text-sm font-medium text-gray-900">
                          {format(new Date(rec.periodStart), 'dd/MM/yyyy', { locale: ptBR })}
                          {' → '}
                          {format(new Date(rec.periodEnd), 'dd/MM/yyyy', { locale: ptBR })}
                        </div>
                        <div className="text-xs text-gray-500">
                          {format(new Date(rec.createdAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <StatusBadge status={rec.status} />
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right">
                        <span className="flex items-center justify-end text-green-600">
                          <CheckCircle2 className="mr-1 h-4 w-4" />
                          {rec.matchedCount}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right">
                        <span className="flex items-center justify-end text-yellow-600">
                          <Clock className="mr-1 h-4 w-4" />
                          {rec.unmatchedCount}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right">
                        <span className="flex items-center justify-end text-red-600">
                          <XCircle className="mr-1 h-4 w-4" />
                          {rec.divergentCount}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right">
                        <span className={`font-medium ${rec.discrepancy > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          R$ {Math.abs(rec.discrepancy).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <footer className="mt-8 text-center text-sm text-gray-500">
          <p>Sistema de Conciliação Financeira ML-MP • v1.0.0</p>
          <p className="mt-1">
            API Docs: <a href="/api/docs" target="_blank" className="text-blue-600 hover:underline">/api/docs</a>
          </p>
        </footer>
      </main>
    </div>
  );
}
