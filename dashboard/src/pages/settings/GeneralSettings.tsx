import { Settings as SettingsIcon } from 'lucide-react';

interface Props {
  settings: Record<string, string>;
  onSettingChange: (key: string, value: string) => void;
}

export function GeneralSettings({ settings, onSettingChange }: Props) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
        <SettingsIcon className="w-4 h-4 text-gray-400" /> General Settings
      </h3>
      <p className="text-xs text-gray-500">
        Runtime settings that affect server behavior directly. Browser Headless applies on next browser launch.
      </p>

      {/* Chat Behavior */}
      <div className="space-y-3 pb-4 border-b border-gray-800">
        <h4 className="text-xs font-medium text-gray-400 uppercase">Chat Behavior</h4>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Chat Reply Delay (ms)</label>
            <input
              type="number"
              value={settings['chat_reply_delay'] || '3000'}
              onChange={e => onSettingChange('chat_reply_delay', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-gray-600 mt-1">Delay before replying to chat messages (milliseconds)</p>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Comment Reply Delay (ms)</label>
            <input
              type="number"
              value={settings['comment_reply_delay'] || '5000'}
              onChange={e => onSettingChange('comment_reply_delay', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-gray-600 mt-1">Delay before replying to comments (milliseconds)</p>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Auto Reply Enabled</label>
            <select
              value={settings['auto_reply_enabled'] || 'true'}
              onChange={e => onSettingChange('auto_reply_enabled', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
            <p className="text-[10px] text-gray-600 mt-1">Enable automatic chat replies</p>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Auto Comment Reply Enabled</label>
            <select
              value={settings['auto_comment_reply_enabled'] || 'true'}
              onChange={e => onSettingChange('auto_comment_reply_enabled', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
            <p className="text-[10px] text-gray-600 mt-1">Enable automatic comment replies</p>
          </div>
        </div>
      </div>

      {/* Browser & Memory */}
      <div className="space-y-3 pb-4 border-b border-gray-800">
        <h4 className="text-xs font-medium text-gray-400 uppercase">Browser & Memory</h4>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Browser Headless</label>
            <select
              value={settings['browser_headless'] || 'false'}
              onChange={e => onSettingChange('browser_headless', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
            >
              <option value="false">No (show browser)</option>
              <option value="true">Yes (hidden)</option>
            </select>
            <p className="text-[10px] text-gray-600 mt-1">Hide browser window on startup</p>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Max Conversation Memory</label>
            <input
              type="number"
              value={settings['max_memory_messages'] || '25'}
              onChange={e => onSettingChange('max_memory_messages', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-gray-600 mt-1">Maximum messages kept in conversation history</p>
          </div>
        </div>
      </div>

      {/* AI Processing */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-gray-400 uppercase">AI Processing</h4>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Max Tool Retries</label>
            <input
              type="number"
              value={settings['max_tool_retries'] || '3'}
              onChange={e => onSettingChange('max_tool_retries', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-gray-600 mt-1">Maximum retries for tool execution failures</p>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Swarm Timeout (ms)</label>
            <input
              type="number"
              value={settings['swarm_timeout_ms'] || '30000'}
              onChange={e => onSettingChange('swarm_timeout_ms', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-gray-600 mt-1">Timeout for agent swarm operations (milliseconds)</p>
          </div>
        </div>
      </div>
    </div>
  );
}
