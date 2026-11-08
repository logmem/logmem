'use client';

import { useState } from 'react';
import { Copy, Trash2, PowerOff, ShieldCheck, Check } from 'lucide-react';

interface AgentKey {
  id: string;
  agent: string;
  space: string;
  label: string;
  readOnly: boolean;
  createdAt: string;
}

interface ConnectedApp {
  id: string;
  app: string;
  agent: string;
  space: string;
  lastUsed: string;
}

export default function AccessPage({ params }: { params: { space: string } }) {
  const [keys, setKeys] = useState<AgentKey[]>([
    { id: 'k1', agent: 'claude-code', space: params.space, label: 'Terminal CLI dev', readOnly: false, createdAt: '2026-11-06' },
    { id: 'k2', agent: 'codex', space: params.space, label: 'PR reviewer', readOnly: true, createdAt: '2026-11-05' },
    { id: 'k3', agent: 'gemini-app', space: params.space, label: 'Local Mac Desktop', readOnly: false, createdAt: '2026-11-07' },
  ]);

  const [apps, setApps] = useState<ConnectedApp[]>([
    { id: 'a1', app: 'Claude Desktop', agent: 'claude-code', space: params.space, lastUsed: '4m ago' },
    { id: 'a2', app: 'Codex MCP Client', agent: 'codex', space: params.space, lastUsed: '18m ago' },
  ]);

  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState<{ agent: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!freshKey) return;
    navigator.clipboard.writeText(freshKey.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-8 font-sans">
      {/* Page Header */}
      <div className="pb-4 border-b border-[#D3DAD8] dark:border-[#2B3835]">
        <h1 className="text-2xl font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
          Agent access
        </h1>
        <p className="text-sm text-[#46534F] dark:text-[#B3BEBA] mt-1">
          Keys and connected apps that can read and write your memory.
        </p>
      </div>

      {/* Fresh Key Reveal Banner */}
      {freshKey && (
        <div className="p-4 rounded-lg border border-[#0E6863] dark:border-[#4FC3B8] bg-[#DDF1EE] dark:bg-[#0F2D2A] text-[#121A19] dark:text-[#E9EEEC] space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#0E6863] dark:text-[#4FC3B8] font-['IBM_Plex_Mono']">
            New key for {freshKey.agent}. Save this now; it will not be displayed again.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={freshKey.key}
              className="flex-1 bg-white dark:bg-[#121A19] border border-[#D3DAD8] dark:border-[#2B3835] px-3 py-1.5 rounded font-['IBM_Plex_Mono'] text-xs select-all text-[#121A19] dark:text-[#E9EEEC]"
            />
            <button
              onClick={handleCopy}
              className="px-3 py-1.5 text-xs font-medium bg-[#0E6863] dark:bg-[#4FC3B8] text-white dark:text-[#121A19] rounded hover:opacity-90 flex items-center gap-1.5"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy key'}
            </button>
            <button
              onClick={() => setFreshKey(null)}
              className="px-3 py-1.5 text-xs font-medium border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] text-[#46534F] dark:text-[#B3BEBA] rounded hover:text-[#121A19] dark:hover:text-[#E9EEEC]"
            >
              Done, hide it
            </button>
          </div>
        </div>
      )}

      {/* Create Key Form (ASD-STE100 Plain Language) */}
      <div className="p-5 border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] rounded-lg shadow-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[#5C6966] dark:text-[#97A4A0] font-['IBM_Plex_Mono'] mb-4">
          Create agent key
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const agent = (form.elements.namedItem('agent') as HTMLInputElement).value;
            setFreshKey({ agent, key: `lmk_live_${crypto.randomUUID().replace(/-/g, '')}` });
            form.reset();
          }}
          className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end"
        >
          <div>
            <label className="block text-xs font-['IBM_Plex_Mono'] text-[#46534F] dark:text-[#B3BEBA] mb-1">
              Agent name
            </label>
            <input
              name="agent"
              required
              pattern="[a-z][a-z0-9_.-]*"
              placeholder="e.g. codex"
              className="w-full bg-[#F4F6F5] dark:bg-[#080D0C] border border-[#D3DAD8] dark:border-[#2B3835] px-3 py-1.5 rounded text-sm font-['IBM_Plex_Mono'] text-[#121A19] dark:text-[#E9EEEC] focus:border-[#0E6863] dark:focus:border-[#4FC3B8] outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-['IBM_Plex_Mono'] text-[#46534F] dark:text-[#B3BEBA] mb-1">
              Label
            </label>
            <input
              name="label"
              placeholder="Where key lives"
              className="w-full bg-[#F4F6F5] dark:bg-[#080D0C] border border-[#D3DAD8] dark:border-[#2B3835] px-3 py-1.5 rounded text-sm text-[#121A19] dark:text-[#E9EEEC] focus:border-[#0E6863] dark:focus:border-[#4FC3B8] outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-['IBM_Plex_Mono'] text-[#46534F] dark:text-[#B3BEBA] mb-1">
              Access
            </label>
            <select
              name="scope"
              className="w-full bg-[#F4F6F5] dark:bg-[#080D0C] border border-[#D3DAD8] dark:border-[#2B3835] px-3 py-1.5 rounded text-sm text-[#121A19] dark:text-[#E9EEEC] focus:border-[#0E6863] dark:focus:border-[#4FC3B8] outline-none"
            >
              <option value="rw">Read and write</option>
              <option value="ro">Read only</option>
            </select>
          </div>
          <button
            type="submit"
            className="w-full py-2 bg-[#0E6863] dark:bg-[#4FC3B8] text-white dark:text-[#121A19] text-xs font-semibold rounded hover:opacity-90 transition-opacity"
          >
            Create key
          </button>
        </form>
      </div>

      {/* Keys Table */}
      <section className="space-y-3">
        <h2 className="text-base font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
          Keys
        </h2>
        <div className="border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] rounded-lg overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#F4F6F5] dark:bg-[#19231F] border-b border-[#D3DAD8] dark:border-[#2B3835] text-xs text-[#5C6966] dark:text-[#97A4A0] font-['IBM_Plex_Mono'] uppercase">
              <tr>
                <th className="px-4 py-2.5">Agent</th>
                <th className="px-4 py-2.5">Space</th>
                <th className="px-4 py-2.5">Label</th>
                <th className="px-4 py-2.5">Access</th>
                <th className="px-4 py-2.5">Created</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#D3DAD8] dark:divide-[#2B3835]">
              {keys.map((k) => (
                <tr key={k.id} className="hover:bg-[#F4F6F5]/50 dark:hover:bg-[#19231F]/50">
                  <td className="px-4 py-3 font-['IBM_Plex_Mono'] font-medium text-[#0E6863] dark:text-[#4FC3B8]">
                    {k.agent}
                  </td>
                  <td className="px-4 py-3 text-xs font-['IBM_Plex_Mono'] text-[#5C6966] dark:text-[#97A4A0]">
                    {k.space}
                  </td>
                  <td className="px-4 py-3 text-[#46534F] dark:text-[#B3BEBA]">
                    {k.label}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs rounded font-['IBM_Plex_Mono'] ${
                        k.readOnly
                          ? 'bg-[#FBEED6] text-[#875100] dark:bg-[#2C1F08] dark:text-[#E8A746]'
                          : 'bg-[#E2F1E5] text-[#1E6B35] dark:bg-[#0F2618] dark:text-[#5DC47C]'
                      }`}
                    >
                      {k.readOnly ? 'read only' : 'read and write'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#5C6966] dark:text-[#97A4A0] font-['IBM_Plex_Mono'] text-xs">
                    {k.createdAt}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {confirmRevoke === k.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs text-[#B42318] dark:text-[#F47A66]">Revoke key?</span>
                        <button
                          onClick={() => {
                            setKeys(keys.filter((x) => x.id !== k.id));
                            setConfirmRevoke(null);
                          }}
                          className="px-2 py-1 bg-[#B42318] text-white rounded text-xs font-medium"
                        >
                          Revoke
                        </button>
                        <button
                          onClick={() => setConfirmRevoke(null)}
                          className="px-2 py-1 text-xs text-[#5C6966] hover:text-[#121A19] dark:hover:text-[#E9EEEC]"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmRevoke(k.id)}
                        className="text-xs text-[#5C6966] hover:text-[#B42318] dark:hover:text-[#F47A66] transition-colors"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Connected Apps Table */}
      <section className="space-y-3">
        <h2 className="text-base font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
          Connected apps
        </h2>
        <p className="text-xs text-[#5C6966] dark:text-[#97A4A0]">
          Apps connected via OAuth or the local MCP endpoint. Add https://logmem.si/mcp in your client to connect another.
        </p>
        <div className="border border-[#D3DAD8] dark:border-[#2B3835] bg-white dark:bg-[#121A19] rounded-lg overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#F4F6F5] dark:bg-[#19231F] border-b border-[#D3DAD8] dark:border-[#2B3835] text-xs text-[#5C6966] dark:text-[#97A4A0] font-['IBM_Plex_Mono'] uppercase">
              <tr>
                <th className="px-4 py-2.5">App</th>
                <th className="px-4 py-2.5">Agent</th>
                <th className="px-4 py-2.5">Space</th>
                <th className="px-4 py-2.5">Last used</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#D3DAD8] dark:divide-[#2B3835]">
              {apps.map((a) => (
                <tr key={a.id} className="hover:bg-[#F4F6F5]/50 dark:hover:bg-[#19231F]/50">
                  <td className="px-4 py-3 font-medium text-[#121A19] dark:text-[#E9EEEC]">{a.app}</td>
                  <td className="px-4 py-3 font-['IBM_Plex_Mono'] text-xs text-[#0E6863] dark:text-[#4FC3B8]">{a.agent}</td>
                  <td className="px-4 py-3 font-['IBM_Plex_Mono'] text-xs text-[#5C6966]">{a.space}</td>
                  <td className="px-4 py-3 text-xs text-[#46534F] dark:text-[#B3BEBA]">{a.lastUsed}</td>
                  <td className="px-4 py-3 text-right">
                    {confirmDisconnect === a.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs text-[#B42318] dark:text-[#F47A66]">Disconnect app?</span>
                        <button
                          onClick={() => {
                            setApps(apps.filter((x) => x.id !== a.id));
                            setConfirmDisconnect(null);
                          }}
                          className="px-2 py-1 bg-[#B42318] text-white rounded text-xs font-medium"
                        >
                          Disconnect
                        </button>
                        <button
                          onClick={() => setConfirmDisconnect(null)}
                          className="px-2 py-1 text-xs text-[#5C6966] hover:text-[#121A19] dark:hover:text-[#E9EEEC]"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmDisconnect(a.id)}
                        className="text-xs text-[#5C6966] hover:text-[#B42318] dark:hover:text-[#F47A66] transition-colors"
                      >
                        Disconnect
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
