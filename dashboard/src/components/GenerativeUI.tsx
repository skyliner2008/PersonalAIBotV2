import React from 'react';
import { BarChart, Table, CreditCard } from 'lucide-react';

export interface UIData {
  componentType: string;
  title: string;
  data: any;
}

export function GenerativeUI({ ui }: { ui: UIData }) {
  if (!ui || !ui.componentType) return null;

  switch (ui.componentType) {
    case 'card':
      return (
        <div className="mt-2 p-4 bg-gray-800/80 rounded-xl border border-gray-700 shadow-lg">
          <div className="flex items-center gap-2 mb-2 text-violet-300">
            <CreditCard className="w-5 h-5" />
            <h3 className="font-bold">{ui.title}</h3>
          </div>
          <p className="text-gray-300 text-sm whitespace-pre-wrap">{ui.data?.content || JSON.stringify(ui.data)}</p>
        </div>
      );

    case 'data_table':
      const headers = ui.data?.headers || [];
      const rows = ui.data?.rows || [];
      return (
        <div className="mt-2 w-full overflow-hidden rounded-xl border border-gray-700 shadow-lg">
          <div className="bg-gray-800/80 px-4 py-3 border-b border-gray-700 flex items-center gap-2">
            <Table className="w-5 h-5 text-blue-400" />
            <h3 className="font-bold text-gray-200">{ui.title}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-gray-400">
              <thead className="text-xs text-gray-300 uppercase bg-gray-900/50">
                <tr>
                  {headers.map((h: string, i: number) => (
                    <th key={i} className="px-4 py-2 border-r border-gray-800 last:border-0">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row: any[], i: number) => (
                  <tr key={i} className="border-b border-gray-800 bg-gray-800/30 hover:bg-gray-700/50 transition-colors">
                    {row.map((cell: any, j: number) => (
                      <td key={j} className="px-4 py-2 border-r border-gray-800 last:border-0">{String(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );

    case 'bar_chart':
      // Expecting data: { labels: string[], values: number[] }
      const labels = ui.data?.labels || [];
      const values = ui.data?.values || [];
      const maxVal = Math.max(...values, 1);
      
      return (
        <div className="mt-2 p-4 bg-gray-800/80 rounded-xl border border-gray-700 shadow-lg">
          <div className="flex items-center gap-2 mb-4 text-emerald-400">
            <BarChart className="w-5 h-5" />
            <h3 className="font-bold">{ui.title}</h3>
          </div>
          <div className="flex items-end justify-between h-32 gap-2 mt-4">
            {values.map((val: number, i: number) => {
              const heightPct = Math.max((val / maxVal) * 100, 5);
              return (
                <div key={i} className="flex flex-col items-center justify-end w-full group">
                  <span className="text-[10px] text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity mb-1">{val}</span>
                  <div 
                    className="w-full bg-emerald-500/80 rounded-t-sm hover:bg-emerald-400 transition-colors" 
                    style={{ height: `${heightPct}%` }}
                  ></div>
                  <span className="text-[10px] text-gray-500 mt-2 truncate w-full text-center" title={labels[i]}>
                    {labels[i]?.substring(0, 5) + (labels[i]?.length > 5 ? '..' : '')}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      );

    default:
      return (
        <div className="mt-2 p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-xs text-red-200">
          Unsupported UI Component: {ui.componentType}
        </div>
      );
  }
}
