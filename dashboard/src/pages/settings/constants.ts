import {
  Cpu, Database, Search, Mic, Image, MessageSquare,
} from 'lucide-react';

export const CATEGORY_CONFIG: Record<string, { label: string; labelTh: string; icon: any; color: string; description: string }> = {
  llm:       { label: 'LLM / Chat AI',      labelTh: 'AI สนทนา',         icon: Cpu,           color: 'text-blue-400',   description: 'ผู้ให้บริการ AI สำหรับสนทนาและสร้างข้อความ' },
  embedding: { label: 'Embedding',           labelTh: 'Embedding',        icon: Database,       color: 'text-green-400',  description: 'แปลงข้อความเป็น Vector สำหรับ Memory System' },
  search:    { label: 'Web Search',          labelTh: 'ค้นหาเว็บ',       icon: Search,         color: 'text-cyan-400',   description: 'ค้นหาข้อมูลจากอินเทอร์เน็ต' },
  tts:       { label: 'Text-to-Speech',      labelTh: 'แปลงเสียง',       icon: Mic,            color: 'text-orange-400', description: 'แปลงข้อความเป็นเสียงพูด' },
  image:     { label: 'Image Generation',    labelTh: 'สร้างภาพ',        icon: Image,          color: 'text-pink-400',   description: 'สร้างภาพจากข้อความ (AI Art)' },
  platform:  { label: 'Messaging Platforms', labelTh: 'แพลตฟอร์มแชท',   icon: MessageSquare,  color: 'text-purple-400', description: 'เชื่อมต่อแพลตฟอร์มแชทต่างๆ' },
};

export const AGENT_TASKS = [
  { id: 'general', name: 'General', desc: 'General chat and lightweight tasks' },
  { id: 'complex', name: 'Complex', desc: 'Long-form and multi-step work' },
  { id: 'thinking', name: 'Thinking', desc: 'Reasoning and decision tasks' },
  { id: 'code', name: 'Code', desc: 'Coding and refactoring tasks' },
  { id: 'data', name: 'Data', desc: 'Data analysis and structured outputs' },
  { id: 'web', name: 'Web', desc: 'Web lookup and browsing tasks' },
  { id: 'vision', name: 'Vision', desc: 'Images and multimodal tasks' },
  { id: 'system', name: 'System', desc: 'Internal/system tasks' },
];
