/**
 * ThreadPilot - Content Script
 * Injects a smart sidebar navigator into ChatGPT, Google Gemini,
 * and Anthropic Claude. Extracts messages, labels them, and enables
 * smooth scroll navigation via a minimal sidebar UI.
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────────

  const SIDEBAR_ID = 'threadpilot-sidebar';
  const TOGGLE_BTN_ID = 'threadpilot-toggle';
  const HIGHLIGHT_CLASS = 'threadpilot-highlight';
  const STORAGE_KEY = 'threadpilot-open';
  const THEME_KEY = 'threadpilot-theme'; // 'dark' | 'light'
  const STARS_KEY = 'threadpilot-stars'; // global stars storage
  const TITLES_KEY = 'threadpilot-titles'; // custom user titles

  // Minimum length to consider a response "important"
  const IMPORTANT_THRESHOLD = 200;

  // Debounce delay for MutationObserver in ms
  const DEBOUNCE_DELAY = 600;

  // ─── Platform Definitions ────────────────────────────────────────────────────

  /**
   * Each platform entry defines:
   *   domains    - hostname fragments to match
   *   name       - display name shown in the sidebar header
   *   selectors  - one or more CSS selectors that match individual message nodes
   *   getRole    - function(node) → 'user' | 'assistant'
   */
  const PLATFORMS = {
    chatgpt: {
      domains: ['chatgpt.com', 'chat.openai.com'],
      name: 'ChatGPT',
      key: 'chatgpt',
      // ChatGPT logo: custom PNG added by user
      aiIcon: `<img src="${chrome.runtime.getURL('icons/chatgpt-logo.png')}" width="14" height="14" alt="ChatGPT" style="display: block; border-radius: 2px;" />`,
      selectors: ['[data-message-author-role]'],
      getRole: (node) => node.getAttribute('data-message-author-role') || 'assistant',
    },

    gemini: {
      domains: ['gemini.google.com'],
      name: 'Gemini',
      key: 'gemini',
      // Gemini logo: custom PNG added by user
      aiIcon: `<img src="${chrome.runtime.getURL('icons/gemini-logo.png')}" width="14" height="14" alt="Gemini" style="display: block; border-radius: 2px;" />`,
      selectors: [
        'user-query',
        'model-response',
        '.user-query-bubble-with-background',
        '.response-container',
      ],
      getRole: (node) => {
        const tag = node.tagName ? node.tagName.toLowerCase() : '';
        const cls = node.className || '';
        if (tag === 'user-query' || cls.includes('user-query')) return 'user';
        return 'assistant';
      },
    },

    claude: {
      domains: ['claude.ai'],
      name: 'Claude',
      key: 'claude',
      // Claude / Anthropic logo: custom PNG added by user
      aiIcon: `<img src="https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/claude-color.png" width="14" height="14" alt="Claude" style="display: block; border-radius: 2px;" />`,
      selectors: [
        '[data-testid="user-message"]',
        '[data-testid="assistant-message"]',
        '.human-turn',
        '.assistant-turn',
        '.font-claude-message',
        '[class*="claude-message"]',
        '[data-is-streaming]',
        '.prose',
      ],
      getRole: (node) => {
        const testId = node.getAttribute ? node.getAttribute('data-testid') : '';
        const cls = (typeof node.className === 'string') ? node.className : '';
        if (testId === 'user-message' || cls.includes('human-turn')) return 'user';
        if (
          testId === 'assistant-message' ||
          cls.includes('assistant-turn') ||
          cls.includes('font-claude-message') ||
          cls.includes('claude-message') ||
          cls.includes('prose') ||
          node.hasAttribute('data-is-streaming')
        ) return 'assistant';
        return 'assistant'; // default — Claude context means unknown = AI
      },
    },
  };

  /**
   * Detects the current AI platform from the page hostname.
   * Falls back to chatgpt config if unrecognised.
   * @returns {{ name, selectors, getRole }}
   */
  function detectPlatform() {
    const host = location.hostname;
    for (const key of Object.keys(PLATFORMS)) {
      const p = PLATFORMS[key];
      if (p.domains.some(d => host === d || host.endsWith('.' + d))) {
        return p;
      }
    }
    return PLATFORMS.chatgpt; // safe default
  }

  // Resolved once at script load time
  const PLATFORM = detectPlatform();

  // ─── State ────────────────────────────────────────────────────────────────────

  let sidebar = null;
  let toggleBtn = null;
  let listContainer = null;
  let searchInput = null;
  let isOpen = false;
  let extractedItems = []; // { node, title, type, index }
  let highlightTimeout = null;
  let mutationObserver = null;
  let debounceTimer = null;
  let lastMessageCount = 0;
  let currentFilter = 'all'; // 'all' | 'user' | 'assistant'

  // ─── Utility: Truncate and Title-case a string ────────────────────────────────

  /**
   * Converts a raw message excerpt into a short, readable title.
   * Strips markdown, shortens to first meaningful clause, title-cases it.
   * @param {string} text - raw message text
   * @param {number} maxLen - maximum characters for the title
   * @returns {string}
   */
  function generateTitle(text, maxLen = 68) {
    // Strip common markdown artifacts
    let clean = text
      .replace(/```[\s\S]*?```/g, '[code block]')  // fenced code → [code block]
      .replace(/`[^`]+`/g, match => match.replace(/`/g, '').trim()) // inline code
      .replace(/^#{1,6}\s+/gm, '')             // heading markers
      .replace(/[*_~>]+/g, '')                  // bold/italic markers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links → text
      .replace(/^[-*•]\s+/gm, '')               // list bullets
      .replace(/^\d+\.\s+/gm, '')               // numbered list markers
      .replace(/\n+/g, ' ')                     // newlines → space
      .replace(/\s+/g, ' ')                     // collapse whitespace
      .trim();

    // Prefer a question if it's short enough (clearest intent)
    const qMark = clean.indexOf('?');
    if (qMark > 4 && qMark < 90) {
      clean = clean.slice(0, qMark + 1);
    } else {
      // Otherwise take up to the first sentence end
      const sentenceEnd = clean.search(/[.!](?=\s|$)/);
      if (sentenceEnd > 8 && sentenceEnd < 110) {
        clean = clean.slice(0, sentenceEnd);
      }
    }

    // Truncate to maxLen, cutting at a word boundary
    if (clean.length > maxLen) {
      clean = clean.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
    }

    return clean || 'Message';
  }
  // ─── Message Classification ───────────────────────────────────────────────────

  /**
   * Classifies a message by content rules.
   * @param {string} text
   * @param {string} role - 'user' or 'assistant'
   * @returns {{ type: string, emoji: string }}
   */
  function classifyMessage(text, role) {
    const hasBullets = /^[\-\*•]\s/m.test(text) || /^\d+\.\s/m.test(text);
    const hasQuestion = text.includes('?');
    const isLong = text.length > IMPORTANT_THRESHOLD;

    if (role === 'user' && hasQuestion) {
      return { type: 'question', label: 'Question' };
    }
    if (hasBullets) {
      return { type: 'keyinfo', label: 'Key Info' };
    }
    if (isLong && role === 'assistant') {
      return { type: 'important', label: 'Detail' };
    }
    if (role === 'user') {
      return { type: 'user', label: 'Prompt' };
    }
    return { type: 'response', label: 'Response' };
  }

  // ─── DOM Extraction ───────────────────────────────────────────────────────────

  /**
   * Scans the page for messages using the current platform's selectors
   * and builds extractedItems. Deduplicates nodes that match multiple selectors.
   */
  function extractMessages() {
    // Query all platform selectors at once. By doing this in a single querySelectorAll,
    // the browser naturally guarantees the returned NodeList is in exact Document Order (top-to-bottom).
    const combinedSelector = PLATFORM.selectors.join(', ');
    const seen = new Set();
    let messageNodes = [];

    try {
      document.querySelectorAll(combinedSelector).forEach((node) => {
        if (!seen.has(node)) {
          seen.add(node);
          messageNodes.push(node);
        }
      });
    } catch (_) {
      // Invalid selector string — fallback to empty
    }

    // ── Claude DOM-traversal fallback ──────────────────────────
    // Claude frequently changes its DOM. If we found user messages but
    // zero AI messages via selectors, walk the DOM to pair each user
    // turn with its adjacent AI response sibling.
    if (PLATFORM.key === 'claude') {
      const userNodes = Array.from(seen).filter(
        n => PLATFORM.getRole(n) === 'user'
      );
      const aiNodes = Array.from(seen).filter(
        n => PLATFORM.getRole(n) === 'assistant'
      );

      if (userNodes.length > 0 && aiNodes.length === 0) {
        let chatContainer = null;

        if (userNodes.length > 1) {
          // Find common ancestor of all user nodes
          let curr = userNodes[0];
          while (curr && curr.parentElement && curr.parentElement.tagName !== 'BODY') {
            const parent = curr.parentElement;
            if (userNodes.every(n => parent.contains(n))) {
              chatContainer = parent;
              break;
            }
            curr = parent;
          }
        } else {
          // Only 1 user node: climb until we find a parent with text-heavy children (siblings)
          let curr = userNodes[0];
          while (curr && curr.parentElement && curr.parentElement.tagName !== 'BODY') {
            const parent = curr.parentElement;
            const hasOtherText = Array.from(parent.children).some(
              c => !c.contains(userNodes[0]) && (c.innerText || '').trim().length > 20
            );
            if (hasOtherText) {
              chatContainer = parent;
              break;
            }
            curr = parent;
          }
        }

        if (chatContainer) {
          // Every DOM child that is NOT a user turn and has text = AI turn
          Array.from(chatContainer.children).forEach(child => {
            const containsUser = userNodes.some(u => child.contains(u));
            if (!containsUser) {
              const text = (child.innerText || child.textContent || '').trim();
              if (text.length > 10) {
                if (!seen.has(child)) {
                  seen.add(child);
                  messageNodes.push(child);
                }
              }
            }
          });
        }
      }
    }

    // Deduplicate: If a matched node is inside another matched node, keep only the parent wrapper.
    // This fixes Gemini where 'model-response' directly contains '.response-container'.
    messageNodes = messageNodes.filter(node => {
      return !messageNodes.some(other => other !== node && other.contains(node));
    });

    if (messageNodes.length === lastMessageCount) return false; // no change

    // (Native Document Order is already preserved from the united querySelectorAll + fallback,
    // so no custom complex sorting algorithm is needed anymore.)

    extractedItems = [];
    let index = 0;

    messageNodes.forEach((node) => {
      const role = PLATFORM.getRole(node);
      // Get the inner text, prefer innerText for rendered output
      let rawText = (node.innerText || node.textContent || '').trim();

      // Strip Gemini's hidden screen-reader text anywhere in the message
      rawText = rawText.replace(/(?:You said|Gemini said)[:\s]*/ig, '');

      if (!rawText || rawText.length < 2) return;

      const classification = classifyMessage(rawText, role);
      const title = generateTitle(rawText);

      // Extract subpoints (Table of Contents) from AI responses
      const subpoints = [];
      if (role === 'assistant') {
        const headings = node.querySelectorAll('h2, h3, h4, li > strong:first-child');
        headings.forEach(h => {
          // If it's a strong tag inside a list, we might want the parent list text if it's short, 
          // but the bold part itself is usually a perfect, concise TOC header!
          let t = (h.innerText || '').trim();
          // specifically strip bullet chars
          t = t.replace(/^[\-\*•\d\.]+\s*/, '');
          
          if (t && t.length > 2 && t.length < 45) {
            subpoints.push({ text: t, node: h });
          }
        });
      }

      extractedItems.push({
        node,
        title,
        rawText,   // store full text for hover preview
        role,
        index,
        subpoints, // store subpoints
        ...classification,
      });

      index++;
    });

    lastMessageCount = messageNodes.length;
    return true; // items changed
  }

  // ─── Sidebar Rendering ────────────────────────────────────────────────────────

  /**
   * Renders or re-renders the sidebar list based on extractedItems.
   * Applies search filter if a query is present.
   */
  function renderList(filterQuery = '') {
    if (!listContainer) return;
    listContainer.innerHTML = '';

    const query = filterQuery.toLowerCase().trim();
    let filtered = currentFilter === 'all'
      ? extractedItems
      : extractedItems.filter(item => item.role === currentFilter);
    if (query) {
      filtered = filtered.filter(item => item.title.toLowerCase().includes(query));
    }

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tp-empty';
      empty.textContent = query ? 'No results found.' : 'No messages detected yet.';
      listContainer.appendChild(empty);
      return;
    }

    // Load stars and custom titles
    let starredSet = new Set();
    let customTitles = {};
    try {
      starredSet = new Set(JSON.parse(localStorage.getItem(STARS_KEY) || '[]'));
      customTitles = JSON.parse(localStorage.getItem(TITLES_KEY) || '{}');
    } catch (e) { }

    const starred = filtered.filter(item => starredSet.has(item.rawText.slice(0, 80)));
    const regular = filtered.filter(item => !starredSet.has(item.rawText.slice(0, 80)));

    if (starred.length > 0) {
      const starHeader = document.createElement('div');
      starHeader.className = 'tp-section-header';
      starHeader.textContent = 'Starred';
      listContainer.appendChild(starHeader);

      starred.forEach(item => listContainer.appendChild(createItemElement(item, true, starredSet, customTitles)));

      if (regular.length > 0) {
        const allHeader = document.createElement('div');
        allHeader.className = 'tp-section-header tp-section-header--mt';
        allHeader.textContent = 'All Messages';
        listContainer.appendChild(allHeader);
      }
    }

    regular.forEach((item) => {
      listContainer.appendChild(createItemElement(item, false, starredSet, customTitles));
    });
  }

  /**
   * Creates a single sidebar item DOM element.
   */
  // SVG icon for user role
  const ICON_USER = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  // AI icon is the current platform logo
  const ICON_AI = PLATFORM.aiIcon || `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>`;

  function createItemElement(item, isStarred, starredSet, customTitles) {
    const el = document.createElement('div');
    el.className = `tp-item tp-item--${item.type}`;
    el.dataset.index = item.index;

    // Role icon badge — platform logo for AI, person icon for user
    const badge = document.createElement('span');
    const platformKey = item.role === 'assistant' ? (PLATFORM.key || 'ai') : 'user';
    badge.className = `tp-badge tp-badge--${platformKey}`;
    badge.innerHTML = item.role === 'user' ? ICON_USER : ICON_AI;

    // Text block: title + sub-line
    const textBlock = document.createElement('span');
    textBlock.className = 'tp-item-body';

    const itemKey = item.rawText.slice(0, 80);
    const displayTitle = customTitles[itemKey] || item.title;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tp-item-text';
    titleSpan.textContent = displayTitle;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'tp-item-meta';
    metaSpan.textContent = `${item.role === 'user' ? 'You' : 'AI'} · #${item.index + 1} · ${item.label}`;

    textBlock.appendChild(titleSpan);
    textBlock.appendChild(metaSpan);

    // Render Subpoints if they exist (Table of Contents)
    if (item.subpoints && item.subpoints.length > 0) {
      const subList = document.createElement('div');
      subList.className = 'tp-subpoints';

      const icon = document.createElement('span');
      icon.className = 'tp-subpoints-icon';
      icon.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`;
      subList.appendChild(icon);

      item.subpoints.slice(0, 6).forEach((sp, i, arr) => {
        const spEl = document.createElement('span');
        spEl.className = 'tp-subpoint-item';
        spEl.textContent = sp.text;
        spEl.title = sp.text;

        spEl.addEventListener('click', (e) => {
          e.stopPropagation(); // prevent clicking the parent item
          scrollToMessage({ node: sp.node }); // reuse scroll logic
          markActive(el);
          hidePreview();
        });

        subList.appendChild(spEl);

        if (i < arr.length - 1) {
          const sep = document.createElement('span');
          sep.className = 'tp-subpoint-sep';
          sep.textContent = '·';
          subList.appendChild(sep);
        }
      });

      textBlock.appendChild(subList);
    }

    // Star button
    const starBtn = document.createElement('button');
    starBtn.className = `tp-star-btn ${isStarred ? 'tp-star-btn--active' : ''}`;
    starBtn.setAttribute('title', isStarred ? 'Unstar' : 'Star message');
    starBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="${isStarred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = item.rawText.slice(0, 80);
      if (starredSet.has(key)) {
        starredSet.delete(key);
      } else {
        starredSet.add(key);
      }
      try { localStorage.setItem(STARS_KEY, JSON.stringify([...starredSet])); } catch (err) { }
      renderList(document.querySelector('.tp-search').value);
    });

    // Edit title button (shown on hover)
    const editBtn = document.createElement('button');
    editBtn.className = 'tp-edit-btn';
    editBtn.title = 'Edit title';
    editBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tp-title-input';
      input.value = displayTitle;
      titleSpan.style.display = 'none';
      editBtn.style.display = 'none';
      textBlock.insertBefore(input, metaSpan);
      input.focus();
      const save = () => {
        const newVal = input.value.trim();
        if (newVal && newVal !== displayTitle) {
          customTitles[itemKey] = newVal;
          try { localStorage.setItem(TITLES_KEY, JSON.stringify(customTitles)); } catch (err) { }
        }
        renderList(document.querySelector('.tp-search').value);
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') save();
        if (ev.key === 'Escape') renderList(document.querySelector('.tp-search').value);
      });
    });

    el.appendChild(starBtn);
    el.appendChild(badge);
    el.appendChild(textBlock);
    el.appendChild(editBtn);

    // Hover → show preview card
    el.addEventListener('mouseenter', () => showPreview(item, el));
    el.addEventListener('mouseleave', hidePreview);

    // Click → scroll + highlight
    el.addEventListener('click', () => {
      scrollToMessage(item);
      markActive(el);
      hidePreview();
    });

    return el;
  }

  /**
   * Marks an item as active (selected state in sidebar).
   */
  function markActive(activeEl) {
    listContainer.querySelectorAll('.tp-item').forEach(el => el.classList.remove('tp-item--active'));
    activeEl.classList.add('tp-item--active');
  }

  // ─── Hover Preview Card ───────────────────────────────────────────────────────

  let previewCard = null;
  let previewHideTimer = null;

  /**
   * Builds the preview card DOM element (once) and appends to body.
   */
  function ensurePreviewCard() {
    if (previewCard) return;
    previewCard = document.createElement('div');
    previewCard.id = 'tp-preview';
    previewCard.className = 'tp-preview';
    // Keep card visible when mouse moves over it
    previewCard.addEventListener('mouseenter', () => clearTimeout(previewHideTimer));
    previewCard.addEventListener('mouseleave', hidePreview);
    document.body.appendChild(previewCard);
  }

  /**
   * Shows a preview card to the left of the sidebar for the given item.
   * @param {object} item - extracted message item
   * @param {HTMLElement} anchorEl - the hovered sidebar list item element
   */
  function showPreview(item, anchorEl) {
    clearTimeout(previewHideTimer);
    ensurePreviewCard();

    // Build content
    const preview = item.rawText
      .replace(/```[\s\S]*?```/g, '[code block]')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[*_~#]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);

    const isClipped = item.rawText.replace(/\s+/g, ' ').trim().length > 240;

    const roleIcon = item.role === 'user' ? ICON_USER : ICON_AI;
    const previewBadgeKey = item.role === 'assistant' ? (PLATFORM.key || 'ai') : 'user';
    previewCard.innerHTML = `
      <div class="tp-preview-header">
        <span class="tp-preview-badge tp-badge--${previewBadgeKey}">${roleIcon}</span>
        <span class="tp-preview-label">${item.role === 'user' ? 'Your prompt' : 'AI response'}</span>
        <span class="tp-preview-num">#${item.index + 1}</span>
      </div>
      <div class="tp-preview-body">${escapeHtml(preview)}${isClipped ? '<span class="tp-preview-more">…</span>' : ''}</div>
      <div class="tp-preview-footer">Click to jump to this message</div>
    `;

    // Position: to the left of the sidebar, vertically aligned with the item
    const rect = anchorEl.getBoundingClientRect();
    const cardWidth = 240;
    const cardLeft = rect.left - cardWidth - 10;
    const viewportH = window.innerHeight;

    // Clamp vertically so card doesn't overflow screen bottom
    let cardTop = rect.top;
    const estimatedHeight = 130;
    if (cardTop + estimatedHeight > viewportH - 12) {
      cardTop = viewportH - estimatedHeight - 12;
    }
    if (cardTop < 8) cardTop = 8;

    previewCard.style.left = Math.max(8, cardLeft) + 'px';
    previewCard.style.top = cardTop + 'px';
    previewCard.style.width = cardWidth + 'px';
    previewCard.classList.add('tp-preview--visible');
  }

  /**
   * Hides the preview card with a short delay so mouse can move onto it.
   */
  function hidePreview() {
    previewHideTimer = setTimeout(() => {
      if (previewCard) previewCard.classList.remove('tp-preview--visible');
    }, 120);
  }

  /**
   * Escapes HTML special characters for safe injection into innerHTML.
   */
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Navigation ───────────────────────────────────────────────────────────────

  /**
   * Smoothly scrolls to the target message DOM node and highlights it briefly.
   */
  function scrollToMessage(item) {
    const target = item.node;
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Clear previous highlight
    if (highlightTimeout) clearTimeout(highlightTimeout);
    document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach(el => el.classList.remove(HIGHLIGHT_CLASS));

    // Apply highlight
    target.classList.add(HIGHLIGHT_CLASS);
    highlightTimeout = setTimeout(() => {
      target.classList.remove(HIGHLIGHT_CLASS);
    }, 1800);
  }

  // ─── Sidebar Construction ─────────────────────────────────────────────────────

  /**
   * Builds and injects the full sidebar DOM into document.body.
   */
  function buildSidebar() {
    if (document.getElementById(SIDEBAR_ID)) return; // already exists

    // ── Sidebar container
    sidebar = document.createElement('div');
    sidebar.id = SIDEBAR_ID;
    sidebar.setAttribute('aria-label', 'ThreadPilot sidebar');
    sidebar.setAttribute('role', 'complementary');

    // ── Header
    const header = document.createElement('div');
    header.className = 'tp-header';

    const logo = document.createElement('div');
    logo.className = 'tp-logo';
    logo.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="6" cy="5" r="2" fill="currentColor"/>
        <circle cx="6" cy="12" r="2" fill="currentColor"/>
        <circle cx="6" cy="19" r="2" fill="currentColor"/>
        <line x1="8" y1="5" x2="20" y2="5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="8" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="8" y1="19" x2="16" y2="19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      <span>ThreadPilot</span>
      <span class="tp-platform-chip tp-platform-chip--${PLATFORM.key || 'chatgpt'}">${PLATFORM.name}</span>
    `;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tp-close-btn';
    closeBtn.setAttribute('aria-label', 'Close ThreadPilot');
    closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    closeBtn.addEventListener('click', closeSidebar);

    // ── Theme toggle button (sun/moon)
    const themeBtn = document.createElement('button');
    themeBtn.className = 'tp-theme-btn';
    themeBtn.id = 'tp-theme-btn';
    themeBtn.setAttribute('aria-label', 'Toggle light/dark mode');
    themeBtn.addEventListener('click', toggleTheme);
    // Icon is set by applyTheme()

    header.appendChild(logo);
    header.appendChild(themeBtn);
    header.appendChild(closeBtn);

    // ── Stats bar
    const statsBar = document.createElement('div');
    statsBar.className = 'tp-stats';
    statsBar.id = 'tp-stats';

    // ── Search
    const searchWrap = document.createElement('div');
    searchWrap.className = 'tp-search-wrap';

    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search conversation…';
    searchInput.className = 'tp-search';
    searchInput.setAttribute('aria-label', 'Search messages');
    searchInput.addEventListener('input', (e) => {
      renderList(e.target.value);
    });

    const searchIcon = document.createElement('span');
    searchIcon.className = 'tp-search-icon';
    searchIcon.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);

    // ── Filter Tabs (Prompts / AI / All)
    const filterBar = document.createElement('div');
    filterBar.className = 'tp-filter-bar';
    filterBar.id = 'tp-filter-bar';

    const filters = [
      { key: 'all', label: 'All' },
      { key: 'user', label: 'Prompts' },
      { key: 'assistant', label: 'AI' },
    ];

    filters.forEach(({ key, label }) => {
      const tab = document.createElement('button');
      tab.className = `tp-filter-tab${currentFilter === key ? ' tp-filter-tab--active' : ''}`;
      tab.dataset.filter = key;
      tab.textContent = label;
      tab.addEventListener('click', () => {
        currentFilter = key;
        // Update active class on all tabs
        filterBar.querySelectorAll('.tp-filter-tab').forEach(t =>
          t.classList.toggle('tp-filter-tab--active', t.dataset.filter === key)
        );
        renderList(searchInput ? searchInput.value : '');
      });
      filterBar.appendChild(tab);
    });

    // ── Scrollable list + floating scroll-down button
    const listWrap = document.createElement('div');
    listWrap.className = 'tp-list-wrap';

    listContainer = document.createElement('div');
    listContainer.className = 'tp-list';
    listContainer.setAttribute('role', 'list');

    // Floating circular scroll-to-bottom button (like ChatGPT's own)
    const scrollDownBtn = document.createElement('button');
    scrollDownBtn.className = 'tp-scroll-down';
    scrollDownBtn.id = 'tp-scroll-down';
    scrollDownBtn.setAttribute('aria-label', 'Scroll to bottom');
    scrollDownBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    scrollDownBtn.addEventListener('click', () => {
      listContainer.scrollTo({ top: listContainer.scrollHeight, behavior: 'smooth' });
    });

    // Show/hide the button based on scroll position
    function updateScrollBtn() {
      const { scrollTop, scrollHeight, clientHeight } = listContainer;
      const nearBottom = scrollHeight - scrollTop - clientHeight < 40;
      scrollDownBtn.classList.toggle('tp-scroll-down--visible', !nearBottom && scrollHeight > clientHeight + 10);
    }

    listContainer.addEventListener('scroll', updateScrollBtn, { passive: true });
    // Re-check whenever list re-renders
    const _origRenderList = renderList;
    // We'll call updateScrollBtn after renderList — hooked via MutationObserver on listContainer
    new MutationObserver(updateScrollBtn).observe(listContainer, { childList: true, subtree: false });

    listWrap.appendChild(listContainer);
    listWrap.appendChild(scrollDownBtn);

    // ── Footer actions
    const footer = document.createElement('div');
    footer.className = 'tp-footer';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'tp-action-btn';
    refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh`;
    refreshBtn.addEventListener('click', refreshSidebar);

    const summarizeBtn = document.createElement('button');
    summarizeBtn.className = 'tp-action-btn tp-action-btn--primary';
    summarizeBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> Summarize`;
    summarizeBtn.addEventListener('click', mockSummarize);

    footer.appendChild(refreshBtn);
    footer.appendChild(summarizeBtn);

    // ── Assemble
    sidebar.appendChild(header);
    sidebar.appendChild(statsBar);
    sidebar.appendChild(searchWrap);
    sidebar.appendChild(filterBar);
    sidebar.appendChild(listWrap);
    sidebar.appendChild(footer);

    document.body.appendChild(sidebar);
  }

  /**
   * Updates the stats bar with current message counts.
   */
  function updateStats() {
    const statsEl = document.getElementById('tp-stats');
    if (!statsEl) return;

    const questions = extractedItems.filter(i => i.type === 'question').length;
    const keyInfos = extractedItems.filter(i => i.type === 'keyinfo').length;
    const total = extractedItems.length;

    const userCount = extractedItems.filter(i => i.role === 'user').length;
    const aiCount = extractedItems.filter(i => i.role === 'assistant').length;
    statsEl.innerHTML = `
      <span class="tp-stat"><strong>${total}</strong> messages</span>
      <span class="tp-stat-sep">·</span>
      <span class="tp-stat">${userCount} from you</span>
      <span class="tp-stat-sep">·</span>
      <span class="tp-stat">${aiCount} AI</span>
    `;
  }

  // ─── Toggle Button ────────────────────────────────────────────────────────────

  /**
   * Builds and injects the floating toggle button.
   */
  function buildToggleButton() {
    if (document.getElementById(TOGGLE_BTN_ID)) return;

    toggleBtn = document.createElement('button');
    toggleBtn.id = TOGGLE_BTN_ID;
    toggleBtn.setAttribute('aria-label', 'Open ThreadPilot navigator');
    toggleBtn.title = 'ThreadPilot — Click to open';
    toggleBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="6" cy="5" r="2" fill="currentColor"/>
        <circle cx="6" cy="12" r="2" fill="currentColor"/>
        <circle cx="6" cy="19" r="2" fill="currentColor"/>
        <line x1="9" y1="5" x2="20" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <line x1="9" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <line x1="9" y1="19" x2="16" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;

    toggleBtn.addEventListener('click', openSidebar);
    document.body.appendChild(toggleBtn);
  }

  // ─── Open / Close ─────────────────────────────────────────────────────────────

  function openSidebar() {
    if (!sidebar) buildSidebar();
    isOpen = true;
    sidebar.classList.add('tp-sidebar--open');
    if (toggleBtn) toggleBtn.style.display = 'none';

    // Extract and render on open
    extractMessages();
    renderList();
    updateStats();

    try { localStorage.setItem(STORAGE_KEY, 'true'); } catch (_) { }
  }

  function closeSidebar() {
    if (!sidebar) return;
    isOpen = false;
    sidebar.classList.remove('tp-sidebar--open');
    if (toggleBtn) toggleBtn.style.display = 'flex';
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { }
  }

  /**
   * Force re-extract messages and re-render the sidebar.
   */
  function refreshSidebar() {
    lastMessageCount = 0; // force re-extraction
    extractMessages();
    const query = searchInput ? searchInput.value : '';
    renderList(query);
    updateStats();

    // Briefly animate the list to confirm refresh
    if (listContainer) {
      listContainer.style.opacity = '0.4';
      setTimeout(() => { listContainer.style.opacity = '1'; }, 280);
    }
  }

  // ─── Mock Summarize ───────────────────────────────────────────────────────────

  /**
   * Mock "Summarize Chat" feature — shows a toast notification.
   * In a future version, this could call an AI API.
   */
  function mockSummarize() {
    const total = extractedItems.length;
    const questions = extractedItems.filter(i => i.type === 'question').length;
    const keyInfos = extractedItems.filter(i => i.type === 'keyinfo').length;

    showToast(
      `Chat Analysis\n${total} messages · ${questions} questions · ${keyInfos} key points extracted.\n(Full summarization coming soon)`
    );
  }

  /**
   * Displays a small toast notification.
   */
  function showToast(message) {
    const existing = document.getElementById('tp-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'tp-toast';
    toast.className = 'tp-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('tp-toast--visible');
    });

    setTimeout(() => {
      toast.classList.remove('tp-toast--visible');
      setTimeout(() => toast.remove(), 400);
    }, 3500);
  }

  // ─── MutationObserver ─────────────────────────────────────────────────────────

  /**
   * Watches the DOM for new messages added to the conversation.
   * Uses debouncing to avoid excessive re-renders.
   */
  function startObserver() {
    if (mutationObserver) return;

    mutationObserver = new MutationObserver(() => {
      if (!isOpen) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const changed = extractMessages();
        if (changed) {
          const query = searchInput ? searchInput.value : '';
          renderList(query);
          updateStats();
        }
      }, DEBOUNCE_DELAY);
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ─── Keyboard Shortcut ────────────────────────────────────────────────────────

  /**
   * Alt+T toggles the sidebar open/closed.
   */
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 't') {
      e.preventDefault();
      isOpen ? closeSidebar() : openSidebar();
    }
  });

  // ─── Theme ───────────────────────────────────────────────────────────────────

  // SVG icons for the theme toggle button
  const ICON_MOON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>`;
  const ICON_SUN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

  /**
   * Reads the saved theme from localStorage and applies it to the sidebar
   * and toggle button (and body tag for preview/toast cards).
   */
  function applyTheme() {
    let theme;
    try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (_) { theme = 'dark'; }

    const isLight = theme === 'light';

    // Apply theme attribute — CSS takes care of variable overrides
    if (sidebar) sidebar.setAttribute('data-tp-theme', theme);
    if (toggleBtn) toggleBtn.setAttribute('data-tp-theme', theme);
    document.body.setAttribute('data-tp-theme', theme);

    // Update button icon: show opposite mode icon (moon = switch to dark, sun = switch to light)
    const btn = document.getElementById('tp-theme-btn');
    if (btn) {
      btn.innerHTML = isLight ? ICON_MOON : ICON_SUN;
      btn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
    }
  }

  /**
   * Toggles between dark and light themes and persists the preference.
   */
  function toggleTheme() {
    let current;
    try { current = localStorage.getItem(THEME_KEY) || 'dark'; } catch (_) { current = 'dark'; }
    const next = current === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { }
    applyTheme();
  }

  // ─── Initialization ───────────────────────────────────────────────────────────

  /**
   * Entry point — waits for the AI platform's interface to load, then initializes.
   * Uses a longer delay for Gemini/Claude which hydrate slower than ChatGPT.
   */
  function init() {
    buildToggleButton();
    startObserver();
    applyTheme(); // restore saved theme preference

    // Re-open if user had it open previously
    try {
      if (localStorage.getItem(STORAGE_KEY) === 'true') {
        openSidebar();
      }
    } catch (_) { }
  }

  // ─── Popup Message Listener ─────────────────────────────────────────────────

  /**
   * Handles messages sent from popup.js via chrome.tabs.sendMessage.
   * Actions: 'open-sidebar', 'refresh-sidebar'
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.action) return;

    switch (message.action) {
      case 'open-sidebar':
        isOpen ? null : openSidebar();
        sendResponse({ ok: true });
        break;
      case 'refresh-sidebar':
        if (isOpen) refreshSidebar();
        else openSidebar();
        sendResponse({ ok: true });
        break;
      default:
        break;
    }
    return true; // keep channel open for async sendResponse
  });

  // Wait for body to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // ChatGPT is an SPA — use a short delay to let React hydrate
    setTimeout(init, 800);
  }

})();
