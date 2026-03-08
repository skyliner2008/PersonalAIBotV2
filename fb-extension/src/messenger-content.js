// ============================================================
// FB AI Agent — Messenger Content Script v5
// State machine: SCANNING → PROCESSING → STANDBY
//
// FLOW ที่ถูกต้องตามการใช้งานจริงของ Facebook Messenger:
// 1. เปิด Auto-Reply → bg เปิด /messages/
// 2. SCAN: คลิก "ยังไม่ได้อ่าน" ใน sidebar filter menu → เก็บ queue
// 3. PROCESS: เข้าทีละ conv → ดูว่า last msg เป็นของเขา → ส่ง AI reply
// 4. STANDBY: **อยู่ที่ Messenger** → ทุก 45 วิ คลิก "ยังไม่ได้อ่าน" ใหม่
//    (Messenger ไม่แจ้งเตือนที่แท็ป notification ของ Facebook
//     ต้องใช้ปุ่ม ทั้งหมด | ยังไม่ได้อ่าน | กลุ่ม ในหน้า Messenger เท่านั้น)
//
// ABORT: เมื่อปิด Auto-Reply → generation++ → ทุก async function จะ
//        ตรวจ generation และหยุดทันที
// ============================================================

(() => {
  'use strict';

  const STORAGE_KEY = 'fbai_v4';
  const MIN_REPLY_GAP_MS = 60000;   // 60s min between replies per conv
  const STANDBY_POLL_MS = 45000;   // 45s standby poll interval
  const SIDEBAR_WAIT_MS = 3000;    // wait for sidebar to load
  const FILTER_WAIT_MS = 2500;    // wait after clicking filter

  // ================================================================
  // ABORT CONTROL — generation counter
  // Every time auto-reply is toggled, generation increments.
  // All async functions receive `gen` param and check before continuing.
  // ================================================================
  let generation = 0;
  function aborted(gen) { return gen !== generation; }

  // ================================================================
  // MODULE-LEVEL CLEANUP REFS
  // ================================================================
  let standbyInterval = null;
  let activeChatPollInterval = null;
  let sidebarObserver = null;
  let chatObserver = null;

  function clearAllPolling() {
    if (standbyInterval) { clearInterval(standbyInterval); standbyInterval = null; }
    if (activeChatPollInterval) { clearInterval(activeChatPollInterval); activeChatPollInterval = null; }
    if (sidebarObserver) { sidebarObserver.disconnect(); sidebarObserver = null; }
    if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
  }

  // ================================================================
  // LOGGING
  // ================================================================
  function log(level, msg) {
    const prefix = '[FB AI v5]';
    if (level === 'error') console.error(prefix, msg);
    else if (level === 'warn') console.warn(prefix, msg);
    else console.log(prefix, msg);
    try { chrome.runtime.sendMessage({ type: 'extLog', level, source: 'CS', msg }).catch(() => { }); } catch { }
  }

  // ================================================================
  // STATE (persisted via chrome.storage.local)
  // ================================================================
  function loadState() {
    return new Promise(r => chrome.storage.local.get(STORAGE_KEY, d => r(d[STORAGE_KEY] || {})));
  }

  function saveState(updates) {
    return new Promise(async r => {
      const cur = await loadState();
      chrome.storage.local.set({ [STORAGE_KEY]: { ...cur, ...updates } }, r);
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ================================================================
  // PAGE DETECTION
  // ================================================================
  function getPageType() {
    const p = location.pathname;
    if (/\/messages\/(t|e2ee)\//.test(p)) return 'conversation';
    if (/\/messages/.test(p)) return 'messages_inbox';
    return 'home';
  }

  function getConvId() {
    const m = location.pathname.match(/\/messages\/[^/]+\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function getChatName() {
    for (const sel of [
      'div[role="main"] h2 span',
      'div[role="main"] a[role="link"] span[dir="auto"]',
      'div[role="main"] span[title]',
    ]) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }
    return null;
  }

  // ================================================================
  // OWN-MESSAGE DETECTION (5 strategies)
  // ================================================================
  function isOwnMessage(rowEl) {
    // 1. aria-label "You sent" / "คุณส่ง"
    for (const el of rowEl.querySelectorAll('[aria-label]')) {
      const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
      if (lbl.includes('you sent') || lbl.includes('คุณส่ง') || lbl.startsWith('sent ')) return true;
    }
    // 2. Right-justified container
    try { if (window.getComputedStyle(rowEl).justifyContent === 'flex-end') return true; } catch { }
    // 3. Blue bubble background
    for (const d of rowEl.querySelectorAll('div')) {
      try {
        const bg = window.getComputedStyle(d).backgroundColor;
        if (bg === 'rgb(0, 132, 255)' || bg === 'rgb(0, 84, 166)') return true;
      } catch { }
    }
    // 4. Right-aligned parent
    const parent = rowEl.parentElement;
    if (parent) {
      try {
        const ps = window.getComputedStyle(parent);
        if (ps.alignItems === 'flex-end' || ps.justifyContent === 'flex-end') return true;
      } catch { }
    }
    // 5. data-testid or class patterns (Facebook sometimes uses these)
    if (rowEl.closest('[class*="outgoing"]') || rowEl.closest('[class*="self"]')) return true;
    return false;
  }

  // ================================================================
  // SIDEBAR FILTER BUTTONS — ทั้งหมด | ยังไม่ได้อ่าน | กลุ่ม
  // ================================================================
  function findFilterButton(targetTexts) {
    // Strategy 1: role="tab" elements (most common for these filters)
    for (const tab of document.querySelectorAll('[role="tab"], [role="option"]')) {
      const text = tab.textContent?.trim();
      if (!text) continue;
      for (const t of targetTexts) {
        if (text.toLowerCase() === t.toLowerCase()) {
          if (tab.offsetParent !== null) return tab;
        }
      }
    }

    // Strategy 2: aria-label matching on interactive elements
    for (const el of document.querySelectorAll('[aria-label]')) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      for (const t of targetTexts) {
        if (label === t.toLowerCase() || label.includes(t.toLowerCase())) {
          if (el.offsetParent !== null && el.offsetWidth > 15) return el;
        }
      }
    }

    // Strategy 3: text-matching on spans/divs in the sidebar header area
    // The filter bar is typically near the top of the sidebar
    const sidebarArea = document.querySelector('[role="navigation"]')
      || document.querySelector('[aria-label*="Chat"]')
      || document.querySelector('[aria-label*="แชท"]')
      || document.querySelector('[aria-label*="Messenger"]');
    const root = sidebarArea || document.body;

    for (const el of root.querySelectorAll('a, span, div[role="button"]')) {
      const text = el.textContent?.trim();
      if (!text || text.length > 40) continue;
      for (const t of targetTexts) {
        if (text.toLowerCase() === t.toLowerCase()) {
          if (el.offsetParent !== null && el.offsetWidth > 10 && el.offsetHeight > 10) {
            return el;
          }
        }
      }
    }

    return null;
  }

  async function clickUnreadFilter() {
    const btn = findFilterButton(['ยังไม่ได้อ่าน', 'Unread']);
    if (btn) {
      btn.click();
      log('info', `Clicked "ยังไม่ได้อ่าน" filter`);
      await sleep(FILTER_WAIT_MS);
      return true;
    }
    log('warn', 'Unread filter button not found — trying aria-label search');

    // Fallback: broader search with partial match
    for (const el of document.querySelectorAll('*')) {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.textContent || '').trim().toLowerCase();
      if ((aria.includes('unread') || text === 'unread' || text === 'ยังไม่ได้อ่าน')
        && el.offsetParent !== null && el.offsetWidth > 10) {
        el.click();
        log('info', `Fallback: clicked unread element`);
        await sleep(FILTER_WAIT_MS);
        return true;
      }
    }

    log('error', 'Could not find Unread filter button at all');
    return false;
  }

  async function clickAllFilter() {
    const btn = findFilterButton(['ทั้งหมด', 'All', 'Inbox']);
    if (btn) {
      btn.click();
      log('info', 'Reset to "ทั้งหมด" filter');
      await sleep(1000);
      return true;
    }
    return false;
  }

  // ================================================================
  // SIDEBAR SCANNING — parse conversations from sidebar
  // ================================================================
  function parseRelativeTime(text) {
    if (!text) return Date.now();
    const t = text.toLowerCase().trim();
    const now = Date.now();

    const mMin = t.match(/^(\d+)\s*m/); if (mMin) return now - parseInt(mMin[1]) * 60000;
    const mHr = t.match(/^(\d+)\s*h/); if (mHr) return now - parseInt(mHr[1]) * 3600000;
    const mDay = t.match(/^(\d+)\s*d/); if (mDay) return now - parseInt(mDay[1]) * 86400000;
    const mNa = t.match(/^(\d+)\s*น/); if (mNa) return now - parseInt(mNa[1]) * 60000;   // นาที
    const mCm = t.match(/^(\d+)\s*ชม/); if (mCm) return now - parseInt(mCm[1]) * 3600000;  // ชั่วโมง
    const mWn = t.match(/^(\d+)\s*ว/); if (mWn) return now - parseInt(mWn[1]) * 86400000; // วัน

    if (t.includes('yesterday') || t.includes('เมื่อวาน')) return now - 86400000;
    if (/^(mon|tue|wed|thu|fri|sat|sun|จ\.|อ\.|พ\.|ศ\.|ส\.)/.test(t)) return now - 3 * 86400000;
    if (t.includes('just') || t.includes('now') || t.includes('ขณะ') || t.includes('เมื่อ')) return now;

    // Old date format = old
    if (/\d+\/\d+|\d+\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ม\.ค|ก\.พ|มี\.ค|เม\.ย|พ\.ค|มิ\.ย|ก\.ค|ส\.ค|ก\.ย|ต\.ค|พ\.ย|ธ\.ค)/i.test(t)) {
      return now - 14 * 86400000;
    }
    return now;
  }

  async function scanSidebar(maxAgeDays, processedIds, filterClicked) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const seen = new Map();

    // Check Test Mode overrides
    const state = await loadState();
    const testModeOn = state.testModeEnabled || false;
    const testTarget = state.testTargetId || '';

    const links = document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/"]');
    log('info', `Sidebar: found ${links.length} conversation links`);

    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const m = href.match(/\/messages\/[^/]+\/([^/?#]+)/);
      if (!m) continue;
      const id = m[1];

      // Test Mode Filtering
      if (testModeOn && testTarget) {
        if (id !== testTarget) {
          // Explicitly skip any conversation that is not the test target
          continue;
        }
      }

      if (processedIds.includes(id)) continue;
      if (seen.has(id)) continue;

      // Name
      let name = id;
      for (const s of link.querySelectorAll('span[dir="auto"], span')) {
        const t = s.textContent?.trim();
        if (t && t.length > 1 && t.length < 100 && !/^\d+$/.test(t)) { name = t; break; }
      }

      // Timestamp
      const timeEl = link.querySelector('abbr[title], time[datetime], [title]');
      const timeText = timeEl?.getAttribute('title') || timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';
      const ts = parseRelativeTime(timeText);

      if (ts < cutoff) {
        log('info', `Skip [${id}] (${name}) — too old: "${timeText}"`);
        continue;
      }

      const url = `https://www.facebook.com${href.startsWith('/') ? href : '/' + href}`;

      // If we already clicked "ยังไม่ได้อ่าน" filter, all items shown ARE unread
      if (filterClicked) {
        seen.set(id, { id, name, url, ts });
      } else {
        // Manual unread check (fallback)
        if (isSidebarItemUnread(link)) {
          seen.set(id, { id, name, url, ts });
        }
      }
    }

    const result = [...seen.values()].sort((a, b) => b.ts - a.ts); // newest first
    log('info', `Scan result: ${result.length} unread within ${maxAgeDays} days`);
    return result;
  }

  function isSidebarItemUnread(linkEl) {
    // Blue/notification dot
    for (const el of linkEl.querySelectorAll('span, div, svg')) {
      try {
        const bg = window.getComputedStyle(el).backgroundColor;
        if (bg === 'rgb(24, 119, 242)' || bg === 'rgb(0, 132, 255)') return true;
      } catch { }
    }
    // Bold conversation name
    for (const span of linkEl.querySelectorAll('span')) {
      try {
        const fw = parseInt(window.getComputedStyle(span).fontWeight);
        const t = span.textContent?.trim();
        if (fw >= 700 && t && t.length > 1 && t.length < 80) return true;
      } catch { }
    }
    // aria-label with unread count
    const aria = linkEl.getAttribute('aria-label') || '';
    if (/\d+\s*(unread|ยังไม่)/i.test(aria)) return true;
    return false;
  }

  // ================================================================
  // SCAN PHASE
  // ================================================================
  async function runScanPhase(gen) {
    log('info', '=== SCAN PHASE START ===');
    setBadge('scanning');
    await saveState({ mode: 'scanning' });

    // Wait for sidebar to fully load
    await sleep(SIDEBAR_WAIT_MS);
    if (aborted(gen)) { log('warn', 'Scan aborted (gen)'); return; }

    // Click "ยังไม่ได้อ่าน" filter
    const filterClicked = await clickUnreadFilter();
    if (aborted(gen)) { log('warn', 'Scan aborted after filter click'); return; }

    // Re-read state for latest settings
    const state = await loadState();
    if (!state.autoReply) { log('warn', 'autoReply turned off during scan'); hideBadge(); return; }

    const maxAgeDays = state.maxAgeDays || 7;
    const processed = state.processed || [];
    const unreadConvs = await scanSidebar(maxAgeDays, processed, filterClicked);

    if (aborted(gen)) { log('warn', 'Scan aborted after sidebar parse'); return; }

    if (unreadConvs.length === 0) {
      log('info', `No unread conversations → STANDBY (maxAge=${maxAgeDays}d)`);
      // Reset filter to "ทั้งหมด"
      await clickAllFilter();
      await saveState({ mode: 'standby', queue: [] });
      runStandbyPhase(gen);
      return;
    }

    log('info', `Queue: ${unreadConvs.length} conv(s) — ${unreadConvs.map(c => c.name).join(', ')}`);
    await saveState({ mode: 'processing', queue: unreadConvs });

    // Reset filter before navigating
    await clickAllFilter();

    // Navigate to first in queue
    if (aborted(gen)) return;
    await sleep(1000);
    window.location.href = unreadConvs[0].url;
  }

  // ================================================================
  // PROCESS CURRENT CONVERSATION
  // Returns: 'replied' | 'skipped' | 'error'
  // ================================================================
  async function processCurrentConversation(state, gen) {
    const convId = getConvId();
    if (!convId) { log('error', 'No convId in URL'); return 'error'; }

    const name = getChatName() || convId;
    log('info', `Processing [${name}] (${convId})`);

    // --- Mark as Read (Crucial to prevent infinite loops on skipped messages) ---
    // Clicking the chat input area tells Facebook we "viewed" the chat
    try {
      const box = document.querySelector(
        'div[role="textbox"][contenteditable="true"], ' +
        'div[contenteditable="true"][aria-label*="message"], ' +
        'div[contenteditable="true"][aria-label*="ข้อความ"], ' +
        'div[contenteditable="true"][aria-label]'
      );
      if (box) {
        box.focus();
        // Give FB a moment to process the focus event and mark as read
        await sleep(500);
      }
    } catch (e) { log('warn', 'Could not focus chat box to mark as read'); }
    if (aborted(gen)) return 'skipped';

    // --- Rate limit (Bypass for Admin/Test UI) ---
    const times = state.lastReplyTimes || {};
    const elapsed = Date.now() - (times[convId] || 0);
    const isTestAdmin = state.testTargetId && convId === state.testTargetId;

    if (elapsed < MIN_REPLY_GAP_MS && !isTestAdmin) {
      log('warn', `[${name}] rate-limited — ${Math.ceil((MIN_REPLY_GAP_MS - elapsed) / 1000)}s left`);
      return 'skipped';
    }

    // --- Wait for messages to render ---
    await sleep(2500);
    if (aborted(gen)) return 'skipped';

    // --- Find the last message ---
    const rows = [...document.querySelectorAll('div[role="row"]')];
    if (rows.length === 0) { log('warn', `[${name}] No message rows found`); return 'skipped'; }

    const lastRow = rows[rows.length - 1];
    const lastIsOwn = isOwnMessage(lastRow);

    if (lastIsOwn) {
      log('info', `[${name}] Last message is OURS — skip (waiting for customer reply)`);
      return 'skipped';
    }

    // --- Additional anti-duplicate: check if our reply is 2nd-to-last ---
    // If second-to-last message is ours and last is theirs,
    // make sure the incoming message is actually NEW (not same text we already processed)
    if (rows.length >= 2) {
      const secondLast = rows[rows.length - 2];
      if (isOwnMessage(secondLast)) {
        // Our reply is right before their message — good, they replied to us
        // But check lastReplyTimes to avoid re-processing too fast
        const timeSinceLastReply = Date.now() - (times[convId] || 0);
        if (timeSinceLastReply < 10000) { // Less than 10 seconds since we last replied
          log('info', `[${name}] Just replied ${Math.ceil(timeSinceLastReply / 1000)}s ago — waiting for more input`);
          return 'skipped';
        }
      }
    }

    // --- Collect consecutive incoming messages (multi-message context) ---
    // Users often split one thought into 2-3 rapid messages
    const collectedTexts = [];
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 5); i--) {
      const row = rows[i];
      if (isOwnMessage(row)) break; // Stop at our own message

      let rowText = '';
      const rowTexts = row.querySelectorAll('div[dir="auto"]');
      for (const t of rowTexts) {
        const txt = t.textContent?.trim();
        if (txt) rowText = txt;
      }

      // Media detection: images, stickers, voice, video
      if (!rowText) {
        const hasImg = row.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
        const hasVideo = row.querySelector('video');
        const hasAudio = row.querySelector('audio, [aria-label*="voice"], [aria-label*="เสียง"]');
        const hasSvg = row.querySelector('svg');
        if (hasImg) rowText = '[ลูกค้าส่งรูปภาพ]';
        else if (hasVideo) rowText = '[ลูกค้าส่งวิดีโอ]';
        else if (hasAudio) rowText = '[ลูกค้าส่งข้อความเสียง]';
        else if (hasSvg) rowText = '[ลูกค้าส่งสติกเกอร์]';
      }

      if (rowText) collectedTexts.unshift(rowText);
    }

    // Combine multi-messages into one context string
    let lastText = collectedTexts.length > 1
      ? collectedTexts.join('\n')
      : (collectedTexts[0] || '');

    if (!lastText) { log('warn', `[${name}] Could not extract message text`); return 'skipped'; }

    // --- Anti-loop: skip if this matches our last reply ---
    const lastReplyTexts = state.lastReplyTexts || {};
    if (lastReplyTexts[convId] && lastText === lastReplyTexts[convId]) {
      log('info', `[${name}] Last message matches our last reply — skip (anti-loop)`);
      return 'skipped';
    }

    log('info', `[${name}] Incoming: "${lastText.substring(0, 80)}"`);
    if (aborted(gen)) return 'skipped';

    // ==========================================
    // ADMIN CHAT COMMANDS
    // ==========================================
    const testModeOn = state.testModeEnabled || false;
    const testTarget = state.testTargetId || '';

    // If we are currently talking to the Admin ID (even if Test Mode is off, Admin ID acts as master)
    if (testTarget && convId === testTarget) {
      if (lastText.startsWith('/pause') || lastText.startsWith('/stop')) {
        log('info', `[ADMIN COMMAND] Received ${lastText} — shutting down`);
        // Send a final confirmation reply
        await sendReply(`[🤖 System] Auto-reply is now PAUSED. To restart, use the extension panel.`);
        // Tell background to turn off autoReply
        chrome.runtime.sendMessage({ type: 'setAutoReply', enabled: false });
        return 'replied'; // We handled it
      } else if (lastText.startsWith('/status')) {
        log('info', `[ADMIN COMMAND] Received ${lastText} — sending status`);
        const queueCount = (state.queue || []).length;
        const msg = `[🤖 System Status]\nStatus: ACTIVE\nMode: ${state.mode}\nQueue: ${queueCount} chats waiting\nAuto-skip > ${state.maxAgeDays || 7} days`;
        await sendReply(msg);

        // Save reply state to prevent anti-loop on our status message
        await saveState({
          lastReplyTimes: { ...times, [convId]: Date.now() },
          lastReplyTexts: { ...(state.lastReplyTexts || {}), [convId]: msg },
        });
        return 'replied';
      } else if (lastText.startsWith('/clearall')) {
        log('info', `[ADMIN COMMAND] Received /clearall — wiping memory`);
        await chrome.runtime.sendMessage({ type: 'clearAllMemory' });
        const msg = `[🤖 System] ล้างความจำ AI (Memory 3-Layer) ของลูกค้าทุกคนเรียบร้อยแล้วครับ! 🧹`;
        await sendReply(msg);

        // Save reply state to prevent anti-loop
        await saveState({
          lastReplyTimes: { ...times, [convId]: Date.now() },
          lastReplyTexts: { ...(state.lastReplyTexts || {}), [convId]: msg },
        });
        return 'replied';
      } else if (lastText.startsWith('/clear ')) {
        const targetToClear = lastText.replace('/clear ', '').trim();
        log('info', `[ADMIN COMMAND] Received /clear — clearing memory for ${targetToClear}`);
        if (targetToClear) {
          await chrome.runtime.sendMessage({ type: 'clearMemory', convId: targetToClear });
          const msg = `[🤖 System] ล้างความจำ AI ของไอดี ${targetToClear} เรียบร้อยแล้วครับ! 🧹`;
          await sendReply(msg);

          await saveState({
            lastReplyTimes: { ...times, [convId]: Date.now() },
            lastReplyTexts: { ...(state.lastReplyTexts || {}), [convId]: msg },
          });
        }
        return 'replied';
      }
    }
    // ==========================================

    // --- Get AI reply ---
    let replyText = null;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'newIncomingMessages',
        messages: [{ id: msgHash(lastText), text: lastText }],
        conversationId: convId,
        userName: name,
      });

      if (aborted(gen)) return 'skipped';
      if (res?.error) { log('error', `AI error: ${res.error}`); return 'error'; }
      if (res?.replies?.length > 0) {
        replyText = res.replies[0].reply;
        log('success', `AI reply: "${replyText.substring(0, 80)}"`);
      } else {
        log('warn', `No AI reply returned`);
        return 'skipped';
      }
    } catch (e) {
      log('error', `Messaging error: ${e.message}`);
      return 'error';
    }

    // --- Human-like delay before typing ---
    await sleep(1500 + Math.random() * 2000);
    if (aborted(gen)) return 'skipped';

    // Removed the inline CHECK BEFORE SENDING block.
    // The chatObserver already handles active chat updates by interrupting Standby/idle states,
    // and this inline check frequently conflicts with DOM changes from media rendering or typing indicators.

    // --- Send reply ---
    const sent = await sendReply(replyText);
    if (!sent) { log('error', `Failed to send reply to [${name}]`); return 'error'; }

    log('success', `Reply sent to [${name}]`);

    // --- Save reply state ---
    await saveState({
      lastReplyTimes: { ...times, [convId]: Date.now() },
      lastReplyTexts: { ...(state.lastReplyTexts || {}), [convId]: replyText },
    });

    return 'replied';
  }

  // ================================================================
  // ADVANCE QUEUE — go to next conversation or standby
  // ================================================================
  async function advanceToNext(convId, gen) {
    // Re-read state fresh (most important for autoReply check)
    const state = await loadState();

    // ABORT CHECK — if auto-reply was turned off, stop immediately
    if (!state.autoReply || aborted(gen)) {
      log('info', 'Auto-reply disabled — stopping after this conversation');
      hideBadge();
      return;
    }

    const queue = (state.queue || []).filter(q => q.id !== convId);
    const processed = [...(state.processed || [])];
    if (convId && !processed.includes(convId)) processed.push(convId);

    await saveState({ queue, processed });

    if (queue.length > 0) {
      log('info', `→ Next: [${queue[0].name}] (${queue.length} remaining)`);
      await sleep(1500);
      if (aborted(gen)) { hideBadge(); return; }
      window.location.href = queue[0].url;
    } else {
      log('info', 'Queue empty → STANDBY');
      await saveState({ mode: 'standby', queue: [] });

      const adminId = state.testTargetId || '';
      const currentPageType = getPageType();
      const currentConvId = getConvId();

      if (adminId && currentConvId !== adminId) {
        // We have an Admin ID, but we are not on it. Navigate to it for Standby.
        log('info', `Navigating to Admin Standby ID [${adminId}]`);
        window.location.href = `https://www.facebook.com/messages/t/${adminId}`;
      } else if (!adminId && currentPageType === 'conversation') {
        // No Admin ID, but we are on a conversation page. Just stay here.
        log('info', `No Admin ID set, staying on current conversation for standby`);
        runStandbyPhase(gen);
      } else if (!adminId && currentPageType !== 'conversation') {
        // No Admin ID, and we are not on a conversation page. fallback to inbox.
        window.location.href = 'https://www.facebook.com/messages/';
      } else {
        // We are already on the Admin ID page
        runStandbyPhase(gen);
      }
    }
  }

  // ================================================================
  // STANDBY PHASE — STAY ON MESSENGER, poll "ยังไม่ได้อ่าน"
  // (ไม่ไปหน้า facebook.com home เพราะ Messenger notification ไม่แสดงที่นั่น)
  // ================================================================
  async function runStandbyPhase(gen) {
    log('info', '=== STANDBY — polling "ยังไม่ได้อ่าน" every 45s ===');
    setBadge('standby');

    // Make sure we're on a Messenger page
    const pageType = getPageType();
    if (pageType === 'home') {
      log('info', 'On home page — navigating to Messenger for standby');
      window.location.href = 'https://www.facebook.com/messages/';
      return;
    }

    // Clear any existing polling
    clearAllPolling();

    // Initial reset: click "ทั้งหมด" so sidebar shows all convs normally
    await clickAllFilter();

    // Start polling interval
    standbyInterval = setInterval(async () => {
      // Check abort
      if (aborted(gen)) {
        clearAllPolling();
        hideBadge();
        return;
      }

      // Re-read state
      const state = await loadState();
      if (!state.autoReply || state.mode !== 'standby') {
        log('info', 'Standby poll: state changed, stopping poll');
        clearAllPolling();
        if (!state.autoReply) hideBadge();
        return;
      }

      log('info', 'Standby poll: checking "ยังไม่ได้อ่าน"...');

      // Click "ยังไม่ได้อ่าน" filter
      const filterClicked = await clickUnreadFilter();
      if (aborted(gen)) { clearAllPolling(); return; }

      // Scan sidebar for unread
      const maxAgeDays = state.maxAgeDays || 7;
      const unread = await scanSidebar(maxAgeDays, state.processed || [], filterClicked);

      if (aborted(gen)) { clearAllPolling(); return; }

      if (unread.length > 0) {
        log('info', `Found ${unread.length} new unread → starting processing`);
        clearAllPolling();
        // KEEP processed list — don't clear it! Prevents re-replying to same conversations
        const existingProcessed = state.processed || [];
        await saveState({ mode: 'processing', queue: unread, processed: existingProcessed });
        // Reset filter before navigating
        await clickAllFilter();
        await sleep(500);
        if (!aborted(gen)) {
          window.location.href = unread[0].url;
        }
      } else {
        log('info', 'No new unread messages — continuing standby');
        // Reset filter to show all
        await clickAllFilter();
      }
    }, STANDBY_POLL_MS);

    // Also set up a MutationObserver on the sidebar for real-time detection
    // This catches new messages that arrive between polls
    const sidebarEl = document.querySelector('[role="navigation"]')
      || document.querySelector('[aria-label*="Chat"]')
      || document.querySelector('[aria-label*="แชท"]');

    if (sidebarEl) {
      sidebarObserver = new MutationObserver(async () => {
        if (aborted(gen)) { clearAllPolling(); return; }

        // Quick check: are there any bold (unread) items in sidebar?
        const boldSpans = sidebarEl.querySelectorAll('span');
        let hasNewUnread = false;
        for (const span of boldSpans) {
          try {
            const fw = parseInt(window.getComputedStyle(span).fontWeight);
            if (fw >= 700) {
              const t = span.textContent?.trim();
              if (t && t.length > 1 && t.length < 80) { hasNewUnread = true; break; }
            }
          } catch { }
        }

        if (hasNewUnread) {
          // Don't immediately jump — the poll will handle it properly
          // This just gives us faster detection
          log('info', 'Sidebar change detected — possible new message');
        }
      });
      sidebarObserver.observe(sidebarEl, { childList: true, subtree: true });
    }

    // Also set up a MutationObserver on the Active Chat window for real-time detection
    // This catches new messages in the currently open chat that Facebook marks as read instantly
    if (pageType === 'conversation') {
      let lastRowCount = document.querySelectorAll('div[role="row"]').length;
      const mainEl = document.querySelector('div[role="main"]') || document.body;

      chatObserver = new MutationObserver(async () => {
        if (aborted(gen)) { clearAllPolling(); return; }
        const currentRows = document.querySelectorAll('div[role="row"]');
        if (currentRows.length > lastRowCount) {
          lastRowCount = currentRows.length;
          const lastRow = currentRows[currentRows.length - 1];
          if (lastRow && !isOwnMessage(lastRow)) {
            log('info', 'Active chat received a new message during standby! Waking up.');
            clearAllPolling(); // Stop standby
            // CRITICAL: increment generation to abort any running standby tasks
            generation++;
            // Immediately put this chat in process queue
            const curId = getConvId();
            if (curId) {
              const st = await loadState();
              await saveState({ mode: 'processing', queue: [{ id: curId, name: getChatName() || curId, url: location.href }], processed: st.processed || [] });
              init(); // Wake up and process immediately
            }
          }
        }
      });
      chatObserver.observe(mainEl, { childList: true, subtree: true });

      // FALLBACK: Active chat fast poll (every 5s)
      let lastKnownText = '';
      try {
        const rows = document.querySelectorAll('div[role="row"]');
        if (rows.length > 0) lastKnownText = rows[rows.length - 1].textContent || '';
      } catch { }

      activeChatPollInterval = setInterval(async () => {
        if (aborted(gen)) { clearAllPolling(); return; }
        const rows = document.querySelectorAll('div[role="row"]');
        if (rows.length === 0) return;

        const lastRow = rows[rows.length - 1];
        const text = lastRow.textContent || '';

        if (!isOwnMessage(lastRow) && text && text !== lastKnownText && !text.includes('กำลังพิมพ์')) {
          lastKnownText = text;
          log('info', 'Active chat poll detected new message! Waking up.');
          clearAllPolling();
          generation++;
          const curId = getConvId();
          if (curId) {
            const st = await loadState();
            await saveState({ mode: 'processing', queue: [{ id: curId, name: getChatName() || curId, url: location.href }], processed: st.processed || [] });
            init();
          }
        }
      }, 5000);
    }
  }

  // ================================================================
  // SEND REPLY (DOM automation)
  // ================================================================
  async function sendReply(text) {
    // Find the message input box
    const box = document.querySelector(
      'div[role="textbox"][contenteditable="true"], ' +
      'div[contenteditable="true"][aria-label*="message"], ' +
      'div[contenteditable="true"][aria-label*="ข้อความ"], ' +
      'div[contenteditable="true"][aria-label]'
    );
    if (!box) { log('error', 'Message input box not found'); return false; }

    box.focus();
    await sleep(400);

    // Clear any existing text
    document.execCommand('selectAll', false, null);
    await sleep(100);
    document.execCommand('delete', false, null);
    await sleep(100);

    // Insert text
    if (!document.execCommand('insertText', false, text)) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
      } catch {
        box.textContent = text;
        box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    }

    await sleep(500);
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await sleep(300);

    // Press Enter to send
    const kev = t => new KeyboardEvent(t, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
    });
    box.dispatchEvent(kev('keydown'));
    await sleep(120);
    box.dispatchEvent(kev('keypress'));
    await sleep(120);
    box.dispatchEvent(kev('keyup'));
    await sleep(1000);

    // Verify sent (box should be empty)
    const remaining = box.textContent?.trim() || '';
    if (remaining.length > 0) {
      // Try clicking the send button
      const sendBtn = document.querySelector(
        '[aria-label="Send"], [aria-label="ส่ง"], [aria-label="Press enter to send"]'
      );
      if (sendBtn) { sendBtn.click(); await sleep(500); }
      else {
        log('warn', 'Message may not have been sent (box not empty, no send button)');
        return false;
      }
    }

    return true;
  }

  // ================================================================
  // VISUAL BADGE
  // ================================================================
  function setBadge(mode) {
    let el = document.getElementById('fbai-v5-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fbai-v5-badge';
      Object.assign(el.style, {
        position: 'fixed', bottom: '12px', right: '12px', zIndex: '99999',
        padding: '6px 14px', borderRadius: '18px', fontSize: '12px',
        fontFamily: '-apple-system,sans-serif', fontWeight: '700',
        cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,.4)',
        transition: '.2s', userSelect: 'none',
      });
      el.title = 'FB AI Agent — click to stop';
      el.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'setAutoReply', enabled: false });
        el.style.display = 'none';
      });
      document.body.appendChild(el);
    }
    const styles = {
      scanning: { bg: '#3b82f6', text: '🔍 Scanning...' },
      processing: { bg: '#f59e0b', text: '💬 Replying...' },
      standby: { bg: '#6b7280', text: '⏸ Standby' },
      idle: { bg: '#22c55e', text: '🤖 AI ON' },
    };
    const s = styles[mode] || styles.idle;
    el.style.background = s.bg;
    el.style.color = '#fff';
    el.textContent = s.text;
    el.style.display = 'block';
  }

  function hideBadge() {
    const el = document.getElementById('fbai-v5-badge');
    if (el) el.style.display = 'none';
  }

  // ================================================================
  // HASH
  // ================================================================
  function msgHash(text) {
    let h = 5381;
    const s = text.substring(0, 80);
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) ^ s.charCodeAt(i); h |= 0; }
    return (h >>> 0).toString(36);
  }

  // ================================================================
  // EXTENSION MESSAGE LISTENER
  // ================================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'autoReplyChanged') {
      log('info', `autoReplyChanged → ${msg.enabled}`);

      // CRITICAL: increment generation to abort all running async functions
      generation++;
      clearAllPolling();

      if (!msg.enabled) {
        hideBadge();
        log('info', 'Bot STOPPED');
      } else {
        // Re-enable: wait a moment then re-init
        const gen = generation;
        setTimeout(() => {
          if (gen === generation) init();
        }, 1500);
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'ping') {
      sendResponse({ pong: true, url: location.href, pageType: getPageType() });
      return true;
    }
  });

  // ================================================================
  // MAIN INIT — runs on every page load
  // ================================================================
  async function init() {
    const gen = generation; // capture current generation
    const state = await loadState();
    const pageType = getPageType();
    const mode = state.mode || 'idle';
    const autoReply = state.autoReply || false;

    log('info', `Init v5: autoReply=${autoReply}, mode=${mode}, page=${pageType}, path=${location.pathname}`);

    if (!autoReply) {
      hideBadge();
      clearAllPolling();
      log('info', 'Auto-reply is OFF');
      return;
    }

    if (aborted(gen)) return;

    // ---- HOME PAGE (facebook.com, not /messages) ----
    if (pageType === 'home') {
      // Bot should always be on Messenger — redirect
      log('info', 'On home page → navigating to Messenger');
      setBadge('scanning');
      await sleep(1500);
      if (!aborted(gen)) {
        window.location.href = 'https://www.facebook.com/messages/';
      }
      return;
    }

    // ---- CONVERSATION PAGE (/messages/t/ID) ----
    if (pageType === 'conversation') {
      const convId = getConvId();

      // Ensure test mode respects the page load
      const testModeOn = state.testModeEnabled || false;
      const testTarget = state.testTargetId || '';

      if (testModeOn && testTarget && convId !== testTarget) {
        log('info', `[TEST MODE] On [${convId}] but target is [${testTarget}] — navigating to target`);
        await saveState({ mode: 'standby', queue: [] });
        // Navigate directly to test target instead of staying on wrong conversation
        window.location.href = `https://www.facebook.com/messages/t/${testTarget}`;
        return;
      }

      if (mode === 'processing') {
        const queue = state.queue || [];

        if (queue.length > 0 && queue[0].id === convId) {
          // Correct conversation — process it
          setBadge('processing');
          const result = await processCurrentConversation(state, gen);
          log('info', `Conv [${convId}] result: ${result}`);
          if (!aborted(gen)) {
            if (result === 'reprocess') {
              log('info', `Reprocessing [${convId}] due to new message...`);
              await sleep(1000);
              init(); // loop back immediately without advancing
              return;
            }
            await sleep(2000);
            await advanceToNext(convId, gen);
          }
        } else if (queue.length > 0) {
          // Wrong conversation — navigate to correct one
          log('warn', `On [${convId}] but queue says [${queue[0].id}] — fixing`);
          setBadge('processing');
          await sleep(1500);
          if (!aborted(gen)) {
            // Anti-loop: If the URL we are jumping to is identical to the one we are on,
            // or if we somehow keep bouncing, we might need a safeguard.
            // For now, let's keep the jump but add logging to see if it loops
            window.location.href = queue[0].url;
          }
        } else {
          // Queue empty in processing mode — go standby
          log('info', 'Processing mode but empty queue → standby');
          await saveState({ mode: 'standby' });
          if (!aborted(gen)) {
            runStandbyPhase(gen);
          }
        }
      } else if (mode === 'standby') {
        // On a conversation page in standby — we can just standby here instead of looping to inbox
        log('info', 'In standby on conversation page → starting standby poll here');
        runStandbyPhase(gen);
      } else {
        // scanning/idle — Facebook redirected us to last conversation
        // Sidebar is visible, so scan from here
        log('info', `On conv [${convId}] in mode=${mode} — starting scan`);
        await runScanPhase(gen);
      }
      return;
    }

    // ---- MESSAGES INBOX (/messages, /messages/) ----
    if (mode === 'standby') {
      runStandbyPhase(gen);
    } else if (mode === 'processing') {
      const queue = state.queue || [];
      if (queue.length > 0) {
        log('info', `On inbox but processing mode — going to queue[0]: [${queue[0].name}]`);
        setBadge('processing');
        await sleep(1000);
        if (!aborted(gen)) {
          window.location.href = queue[0].url;
        }
      } else {
        log('info', 'Processing mode but empty queue on inbox → scan');
        await runScanPhase(gen);
      }
    } else {
      // scanning/idle
      await runScanPhase(gen);
    }
  }

  // ================================================================
  // START — wait for page to be fully loaded
  // ================================================================
  if (document.readyState === 'complete') {
    setTimeout(init, 3000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 3000));
  }

})();
