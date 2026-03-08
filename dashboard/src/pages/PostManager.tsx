import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Plus, Calendar, Send, Trash2, Clock, CheckCircle, AlertCircle, Sparkles, Image } from 'lucide-react';

export function PostManager() {
  const [posts, setPosts] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [form, setForm] = useState({
    content: '',
    post_type: 'text' as string,
    target_type: 'profile' as string,
    target_id: '',
    media_urls: '',
    scheduled_at: '',
    recurring_cron: '',
    ai_topic: '',
    ai_style: 'engaging',
  });

  useEffect(() => {
    loadPosts();
    const interval = setInterval(loadPosts, 10000);
    return () => clearInterval(interval);
  }, []);

  async function loadPosts() {
    try {
      const data = await api.getPosts();
      setPosts(data);
    } catch {}
  }

  async function handleCreate() {
    try {
      await api.createPost({
        content: form.content,
        post_type: form.post_type,
        target_type: form.target_type,
        target_id: form.target_id || undefined,
        media_urls: form.media_urls ? form.media_urls.split('\n').filter(Boolean) : undefined,
        scheduled_at: form.scheduled_at || undefined,
        recurring_cron: form.recurring_cron || undefined,
      });
      setShowForm(false);
      setForm({ content: '', post_type: 'text', target_type: 'profile', target_id: '', media_urls: '', scheduled_at: '', recurring_cron: '', ai_topic: '', ai_style: 'engaging' });
      loadPosts();
    } catch {}
  }

  async function handleAIGenerate() {
    if (!form.ai_topic) return;
    setGenerating(true);
    try {
      const result = await api.generatePostContent(form.ai_topic, form.ai_style);
      setForm(prev => ({ ...prev, content: result.content }));
    } catch {}
    setGenerating(false);
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this post?')) return;
    try {
      await api.deletePost(id);
      loadPosts();
    } catch {}
  }

  const statusColors: Record<string, string> = {
    draft: 'text-gray-400 bg-gray-400/10',
    scheduled: 'text-blue-400 bg-blue-400/10',
    pending_ai: 'text-yellow-400 bg-yellow-400/10',
    ready: 'text-green-400 bg-green-400/10',
    posted: 'text-emerald-400 bg-emerald-400/10',
    failed: 'text-red-400 bg-red-400/10',
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">Auto Post</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-sm font-medium border border-blue-500/30"
        >
          <Plus className="w-4 h-4" /> New Post
        </button>
      </div>

      {/* Create Form */}
      {showForm && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-300">Create Post</h3>

          {/* AI Generate */}
          <div className="bg-gray-800/50 rounded-lg p-3 space-y-2">
            <p className="text-xs font-medium text-purple-400 flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5" /> AI Content Generator
            </p>
            <div className="flex gap-2">
              <input
                value={form.ai_topic}
                onChange={e => setForm(prev => ({ ...prev, ai_topic: e.target.value }))}
                placeholder="Topic / theme (e.g. tech tips, motivation, product launch)"
                className="flex-1 px-3 py-1.5 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-purple-500"
              />
              <select
                value={form.ai_style}
                onChange={e => setForm(prev => ({ ...prev, ai_style: e.target.value }))}
                className="px-3 py-1.5 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200"
              >
                <option value="engaging">Engaging</option>
                <option value="professional">Professional</option>
                <option value="casual">Casual</option>
                <option value="funny">Funny</option>
                <option value="inspirational">Inspirational</option>
              </select>
              <button
                onClick={handleAIGenerate}
                disabled={generating || !form.ai_topic}
                className="px-4 py-1.5 bg-purple-500/20 text-purple-400 rounded-lg hover:bg-purple-500/30 text-xs font-medium border border-purple-500/30 disabled:opacity-50"
              >
                {generating ? 'Generating...' : 'Generate'}
              </button>
            </div>
          </div>

          {/* Content */}
          <textarea
            value={form.content}
            onChange={e => setForm(prev => ({ ...prev, content: e.target.value }))}
            placeholder="Post content..."
            rows={5}
            className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 resize-none"
          />

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase mb-1 block">Type</label>
              <select
                value={form.post_type}
                onChange={e => setForm(prev => ({ ...prev, post_type: e.target.value }))}
                className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
              >
                <option value="text">Text</option>
                <option value="photo">Photo</option>
                <option value="video">Video</option>
                <option value="link">Link</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase mb-1 block">Target</label>
              <select
                value={form.target_type}
                onChange={e => setForm(prev => ({ ...prev, target_type: e.target.value }))}
                className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
              >
                <option value="profile">Profile</option>
                <option value="page">Page</option>
                <option value="group">Group</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase mb-1 block">Target ID</label>
              <input
                value={form.target_id}
                onChange={e => setForm(prev => ({ ...prev, target_id: e.target.value }))}
                placeholder="Page/Group URL"
                className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase mb-1 block">Schedule</label>
              <input
                type="datetime-local"
                value={form.scheduled_at}
                onChange={e => setForm(prev => ({ ...prev, scheduled_at: e.target.value }))}
                className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Media URLs */}
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Media URLs (one per line)</label>
            <textarea
              value={form.media_urls}
              onChange={e => setForm(prev => ({ ...prev, media_urls: e.target.value }))}
              placeholder="https://example.com/image.jpg"
              rows={2}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>

          {/* Recurring */}
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Recurring (cron expression, optional)</label>
            <input
              value={form.recurring_cron}
              onChange={e => setForm(prev => ({ ...prev, recurring_cron: e.target.value }))}
              placeholder="0 9 * * * (every day at 9 AM)"
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-1.5 text-xs text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!form.content}
              className="px-4 py-1.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-xs font-medium border border-blue-500/30 disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5 inline mr-1" /> Create Post
            </button>
          </div>
        </div>
      )}

      {/* Posts List */}
      <div className="space-y-3">
        {posts.length === 0 && (
          <div className="text-center py-12 text-gray-600">
            <Calendar className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No posts yet. Create your first post!</p>
          </div>
        )}
        {posts.map(post => (
          <div key={post.id} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusColors[post.status] || 'text-gray-400'}`}>
                    {post.status}
                  </span>
                  <span className="text-[10px] text-gray-500">{post.target_type}</span>
                  {post.post_type !== 'text' && (
                    <span className="text-[10px] text-gray-500 flex items-center gap-0.5">
                      <Image className="w-3 h-3" /> {post.post_type}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-300 whitespace-pre-wrap line-clamp-3">{post.content}</p>
                <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-500">
                  {post.scheduled_at && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {new Date(post.scheduled_at).toLocaleString('th-TH')}
                    </span>
                  )}
                  {post.posted_at && (
                    <span className="flex items-center gap-1 text-green-500">
                      <CheckCircle className="w-3 h-3" /> Posted {new Date(post.posted_at).toLocaleString('th-TH')}
                    </span>
                  )}
                  {post.error_message && (
                    <span className="flex items-center gap-1 text-red-400">
                      <AlertCircle className="w-3 h-3" /> {post.error_message}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleDelete(post.id)}
                className="text-gray-600 hover:text-red-400 shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
