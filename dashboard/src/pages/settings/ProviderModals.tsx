import { useState, useCallback } from 'react';
import { Plus, Save, Edit3 } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { api } from '../../services/api';
import { CATEGORY_CONFIG } from './constants';

interface Props {
  showAddModal: boolean;
  showEditModal: boolean;
  addCategory: string;
  newProvider: any;
  editProvider: any;
  onCloseAdd: () => void;
  onCloseEdit: () => void;
  onCategoryChange: (cat: string) => void;
  onNewProviderChange: (provider: any) => void;
  onEditProviderChange: (provider: any) => void;
  onAddProvider: () => Promise<void>;
  onSaveEdit: () => Promise<void>;
  onLoadProviders: () => Promise<void>;
}

export function ProviderModals({
  showAddModal, showEditModal, addCategory, newProvider, editProvider,
  onCloseAdd, onCloseEdit, onCategoryChange, onNewProviderChange, onEditProviderChange,
  onLoadProviders,
}: Props) {
  const { addToast } = useToast();
  const categories = Object.keys(CATEGORY_CONFIG);

  const parseOptionalJsonObject = (raw: string, fieldLabel: string): Record<string, string> | undefined => {
    if (!raw.trim()) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error(`${fieldLabel} must be a JSON object`);
      }
      return parsed as Record<string, string>;
    } catch {
      throw new Error(`${fieldLabel} must be valid JSON object syntax`);
    }
  };

  const handleAddProvider = useCallback(async () => {
    if (!newProvider.id || !newProvider.name) return;
    try {
      const customHeaders = parseOptionalJsonObject(newProvider.customHeaders, 'Custom Headers');
      const extraConfig = parseOptionalJsonObject(newProvider.extraConfig, 'Extra Config');

      await api.addProvider({
        id: newProvider.id,
        name: newProvider.name,
        type: newProvider.type,
        baseUrl: newProvider.baseUrl,
        defaultModel: newProvider.defaultModel,
        apiKeyEnvVar: newProvider.apiKeyEnvVar || `${newProvider.id.toUpperCase().replace(/-/g, '_')}_API_KEY`,
        models: newProvider.models ? newProvider.models.split(',').map((m: string) => m.trim()).filter(Boolean) : [],
        endpointTemplate: newProvider.endpointTemplate || undefined,
        notes: newProvider.notes || undefined,
        customHeaders,
        extraConfig,
        category: addCategory,
        capabilities: {},
        requiresAuth: true,
        enabled: true,
      });
      onCloseAdd();
      onNewProviderChange({ id: '', name: '', type: 'openai-compatible', baseUrl: '', defaultModel: '', apiKeyEnvVar: '', models: '', endpointTemplate: '', notes: '', customHeaders: '', extraConfig: '' });
      await onLoadProviders();
      addToast('success', `Added provider "${newProvider.name}"`);
    } catch (e: any) {
      addToast('error', e.message || 'Failed to add provider');
    }
  }, [newProvider, addCategory, onCloseAdd, onNewProviderChange, onLoadProviders, addToast]);

  const handleSaveEdit = useCallback(async () => {
    if (!editProvider) return;
    try {
      const customHeaders = parseOptionalJsonObject(editProvider.customHeaders, 'Custom Headers');
      const extraConfig = parseOptionalJsonObject(editProvider.extraConfig, 'Extra Config');

      await api.updateProvider(editProvider.id, {
        name: editProvider.name,
        type: editProvider.type,
        baseUrl: editProvider.baseUrl,
        defaultModel: editProvider.defaultModel,
        apiKeyEnvVar: editProvider.apiKeyEnvVar,
        models: editProvider.models ? editProvider.models.split(',').map((m: string) => m.trim()).filter(Boolean) : [],
        endpointTemplate: editProvider.endpointTemplate || undefined,
        notes: editProvider.notes || undefined,
        customHeaders,
        extraConfig,
      });
      onCloseEdit();
      await onLoadProviders();
      addToast('success', `Updated provider "${editProvider.name}"`);
    } catch (e: any) {
      addToast('error', e.message || 'Failed to update provider');
    }
  }, [editProvider, onCloseEdit, onLoadProviders, addToast]);

  if (!showAddModal && !showEditModal) return null;

  return (
    <>
      {/* Add Provider Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCloseAdd}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-white">เพิ่ม Provider ใหม่</h3>
            <p className="text-[10px] text-gray-500">เพิ่ม API provider ใหม่เข้าระบบ (รองรับ OpenAI-compatible API)</p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Provider ID *</label>
                <input
                  value={newProvider.id}
                  onChange={e => onNewProviderChange({ ...newProvider, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                  placeholder="e.g. my-provider"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">ชื่อแสดง *</label>
                <input
                  value={newProvider.name}
                  onChange={e => onNewProviderChange({ ...newProvider, name: e.target.value })}
                  placeholder="e.g. My Custom AI"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">หมวดหมู่</label>
                <select
                  value={addCategory}
                  onChange={e => onCategoryChange(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                >
                  {categories.map(c => (
                    <option key={c} value={c}>{CATEGORY_CONFIG[c].label} — {CATEGORY_CONFIG[c].labelTh}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Type</label>
                <select
                  value={newProvider.type}
                  onChange={e => onNewProviderChange({ ...newProvider, type: e.target.value })}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                >
                  <option value="openai-compatible">OpenAI-Compatible</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="rest-api">REST API</option>
                  <option value="platform">Platform</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Base URL (Endpoint)</label>
                <input
                  value={newProvider.baseUrl}
                  onChange={e => onNewProviderChange({ ...newProvider, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Default Model</label>
                <input
                  value={newProvider.defaultModel}
                  onChange={e => onNewProviderChange({ ...newProvider, defaultModel: e.target.value })}
                  placeholder="e.g. gpt-4o"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Models (คั่นด้วย comma)</label>
                <input
                  value={newProvider.models}
                  onChange={e => onNewProviderChange({ ...newProvider, models: e.target.value })}
                  placeholder="model-1, model-2, model-3"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Endpoint Template <span className="text-gray-600">(สำหรับ endpoint แปลกๆ เช่น MiniMax)</span>
                </label>
                <input
                  value={newProvider.endpointTemplate}
                  onChange={e => onNewProviderChange({ ...newProvider, endpointTemplate: e.target.value })}
                  placeholder="{baseUrl}/text/chatcompletion_v2?GroupId={groupId}"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Env Variable Name</label>
                <input
                  value={newProvider.apiKeyEnvVar}
                  onChange={e => onNewProviderChange({ ...newProvider, apiKeyEnvVar: e.target.value })}
                  placeholder="auto-generated if empty"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">หมายเหตุ</label>
                <input
                  value={newProvider.notes}
                  onChange={e => onNewProviderChange({ ...newProvider, notes: e.target.value })}
                  placeholder="e.g. ต้องใช้ GroupId"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Custom Headers <span className="text-gray-600">(JSON)</span>
                </label>
                <textarea
                  value={newProvider.customHeaders}
                  onChange={e => onNewProviderChange({ ...newProvider, customHeaders: e.target.value })}
                  placeholder='{"X-Group-Id": "123456", "X-Custom": "value"}'
                  rows={2}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono resize-none"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Extra Config <span className="text-gray-600">(JSON — ค่าเฉพาะทาง เช่น groupId, projectId)</span>
                </label>
                <textarea
                  value={newProvider.extraConfig}
                  onChange={e => onNewProviderChange({ ...newProvider, extraConfig: e.target.value })}
                  placeholder='{"groupId": "your-group-id", "projectId": "..."}'
                  rows={2}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onCloseAdd}
                className="px-4 py-2 text-xs text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 border border-gray-700"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleAddProvider}
                disabled={!newProvider.id || !newProvider.name}
                className="px-4 py-2 text-xs text-green-400 bg-green-500/15 rounded-lg hover:bg-green-500/25 border border-green-500/30 font-medium disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5 inline mr-1" /> เพิ่ม Provider
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Provider Modal */}
      {showEditModal && editProvider && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCloseEdit}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg space-y-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Edit3 className="w-4 h-4 text-yellow-400" />
              แก้ไข Provider: {editProvider.name}
            </h3>
            <p className="text-[10px] text-gray-500 font-mono">ID: {editProvider.id} | Category: {editProvider.category}</p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">ชื่อแสดง</label>
                <input
                  value={editProvider.name}
                  onChange={e => onEditProviderChange({ ...editProvider, name: e.target.value })}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Type</label>
                <select
                  value={editProvider.type}
                  onChange={e => onEditProviderChange({ ...editProvider, type: e.target.value })}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                >
                  <option value="openai-compatible">OpenAI-Compatible</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="rest-api">REST API</option>
                  <option value="platform">Platform</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Base URL (Endpoint)</label>
                <input
                  value={editProvider.baseUrl}
                  onChange={e => onEditProviderChange({ ...editProvider, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Default Model</label>
                <input
                  value={editProvider.defaultModel}
                  onChange={e => onEditProviderChange({ ...editProvider, defaultModel: e.target.value })}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Models (คั่นด้วย comma)</label>
                <input
                  value={editProvider.models}
                  onChange={e => onEditProviderChange({ ...editProvider, models: e.target.value })}
                  placeholder="model-1, model-2"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Endpoint Template <span className="text-gray-600">(สำหรับ endpoint แบบกำหนดเอง)</span>
                </label>
                <input
                  value={editProvider.endpointTemplate}
                  onChange={e => onEditProviderChange({ ...editProvider, endpointTemplate: e.target.value })}
                  placeholder="{baseUrl}/text/chatcompletion_v2?GroupId={groupId}"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Env Variable</label>
                <input
                  value={editProvider.apiKeyEnvVar}
                  onChange={e => onEditProviderChange({ ...editProvider, apiKeyEnvVar: e.target.value })}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">หมายเหตุ</label>
                <input
                  value={editProvider.notes}
                  onChange={e => onEditProviderChange({ ...editProvider, notes: e.target.value })}
                  placeholder="e.g. ต้องใส่ GroupId ใน extraConfig"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Custom Headers <span className="text-gray-600">(JSON)</span>
                </label>
                <textarea
                  value={editProvider.customHeaders}
                  onChange={e => onEditProviderChange({ ...editProvider, customHeaders: e.target.value })}
                  placeholder='{"X-Group-Id": "123456"}'
                  rows={2}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono resize-none"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Extra Config <span className="text-gray-600">(JSON — ค่าเฉพาะทาง เช่น groupId, projectId, region)</span>
                </label>
                <textarea
                  value={editProvider.extraConfig}
                  onChange={e => onEditProviderChange({ ...editProvider, extraConfig: e.target.value })}
                  placeholder='{"groupId": "...", "projectId": "..."}'
                  rows={2}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onCloseEdit}
                className="px-4 py-2 text-xs text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 border border-gray-700"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 text-xs text-yellow-400 bg-yellow-500/15 rounded-lg hover:bg-yellow-500/25 border border-yellow-500/30 font-medium"
              >
                <Save className="w-3.5 h-3.5 inline mr-1" /> บันทึกการแก้ไข
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
