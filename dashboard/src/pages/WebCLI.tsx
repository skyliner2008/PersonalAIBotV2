import { useState, useRef, useEffect } from 'react';
import { Terminal, Send, Trash2 } from 'lucide-react';

interface ChatMessage {
    id: string;
    sender: 'user' | 'bot';
    text: string;
    timestamp: Date;
}

export function WebCLI() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim()) return;

        const userText = input.trim();
        setInput('');

        // Add user message immediately
        const userMsg: ChatMessage = {
            id: Date.now().toString(),
            sender: 'user',
            text: userText,
            timestamp: new Date()
        };
        setMessages(prev => [...prev, userMsg]);
        setIsTyping(true);

        try {
            // Direct call to the new API Endpoint bypassing webhooks
            const res = await fetch('http://localhost:3000/api/cli/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userText, chatId: 'dashboard_local_admin' })
            });

            const data = await res.json();

            const botMsg: ChatMessage = {
                id: (Date.now() + 1).toString(),
                sender: 'bot',
                text: data.error ? `❌ Error: ${data.error}` : data.reply,
                timestamp: new Date()
            };

            setMessages(prev => [...prev, botMsg]);
        } catch (err: any) {
            const errorMsg: ChatMessage = {
                id: (Date.now() + 1).toString(),
                sender: 'bot',
                text: `❌ Network Error: Could not reach the CLI backend. (${err.message})`,
                timestamp: new Date()
            };
            setMessages(prev => [...prev, errorMsg]);
        } finally {
            setIsTyping(false);
        }
    };

    const clearChat = () => {
        if (confirm('Are you sure you want to clear the terminal output?')) {
            setMessages([]);
        }
    };

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] bg-gray-950 p-6">

            <div className="flex items-center justify-between mb-4">
                <div>
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <Terminal className="w-6 h-6 text-green-400" />
                        Web CLI Terminal
                    </h2>
                    <p className="text-sm text-gray-400">Direct connection to the Agent Core (Sandbox Mode)</p>
                </div>

                <button
                    onClick={clearChat}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-900 text-red-400 hover:bg-red-500/10 hover:text-red-300 rounded-lg border border-gray-800 transition-colors"
                >
                    <Trash2 className="w-4 h-4" />
                    Clear Log
                </button>
            </div>

            {/* Terminal View */}
            <div className="flex-1 bg-[#1e1e1e] rounded-t-xl border border-gray-800 overflow-hidden flex flex-col font-mono shadow-2xl">

                {/* Terminal Header */}
                <div className="h-8 bg-black/40 border-b border-gray-800 flex items-center px-4 gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
                    <span className="ml-2 text-xs text-gray-500">agent-core-tty1</span>
                </div>

                {/* Message Output Area */}
                <div className="flex-1 p-4 overflow-y-auto space-y-4">
                    <div className="text-gray-500 text-sm mb-4">
                        <p className="text-green-500/70">Welcome to PersonalAIBotV2 CLI.</p>
                        <p>Connected to backend engine manually.</p>
                        <p className="text-xs mt-2 border-b border-gray-800 pb-2">Use this interface to test evolution tools directly like 'เรียกใช้ self_heal'.</p>
                    </div>

                    {messages.map((msg) => (
                        <div key={msg.id} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                            <div className="flex items-center gap-2 mb-1">
                                <span className={`text-[10px] uppercase font-bold ${msg.sender === 'user' ? 'text-blue-400' : 'text-green-500'}`}>
                                    {msg.sender === 'user' ? 'root@admin' : 'agent@core'}
                                </span>
                                <span className="text-[10px] text-gray-600">
                                    {msg.timestamp.toLocaleTimeString()}
                                </span>
                            </div>
                            <div className={`max-w-[85%] px-4 py-3 rounded-lg text-sm whitespace-pre-wrap ${msg.sender === 'user'
                                ? 'bg-blue-600/20 border border-blue-500/30 text-blue-100 rounded-tr-none'
                                : 'bg-green-500/10 border border-green-500/30 text-green-400 rounded-tl-none'
                                }`}>
                                {msg.text}
                            </div>
                        </div>
                    ))}

                    {isTyping && (
                        <div className="flex flex-col items-start">
                            <span className="text-[10px] uppercase font-bold text-green-500 mb-1">agent@core</span>
                            <div className="px-4 py-3 bg-green-500/5 rounded-lg border border-green-500/10 flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse delay-100"></span>
                                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse delay-200"></span>
                            </div>
                        </div>
                    )}

                    <div ref={messagesEndRef} />
                </div>
            </div>

            {/* Input Form */}
            <form onSubmit={handleSend} className="relative mt-2">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-green-500 font-mono font-bold">{'>'}</span>
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Enter command or message..."
                    className="w-full bg-[#1e1e1e] border border-gray-800 rounded-b-xl py-4 pl-10 pr-16 text-gray-300 font-mono focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 transition-colors"
                    disabled={isTyping}
                    autoFocus
                    autoComplete="off"
                />
                <button
                    type="submit"
                    disabled={!input.trim() || isTyping}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-green-500/20 text-green-500 hover:bg-green-500/30 disabled:opacity-50 transition-colors"
                >
                    <Send className="w-4 h-4" />
                </button>
            </form>

        </div>
    );
}
