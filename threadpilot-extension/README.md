# ThreadPilot 🧭

> **Smart sidebar navigator for long ChatGPT conversations.**  
> Jump to any message instantly — questions, key points, and important responses, all in one panel.

---

## ✨ Features

- **Smart Message Extraction** — Automatically detects all messages and classifies them as questions ❓, key points 📌, or important responses ⭐
- **Short Titles** — Each message is summarized into a 1-line readable title
- **Smooth Navigation** — Click any item to scroll there with a brief highlight effect
- **Live Search** — Filter the sidebar by keyword in real time
- **Auto-Refresh** — MutationObserver watches for new messages and updates the sidebar automatically
- **Chat Stats** — Shows total messages, questions, and key points at a glance
- **Mock Summarize** — One-click summary of the conversation (API integration ready)
- **Keyboard Shortcut** — `Alt + T` toggles the sidebar anywhere on ChatGPT

---

## 📁 Project Structure

```
threadpilot-extension/
├── manifest.json      # Chrome Extension Manifest V3
├── content.js         # Core logic: sidebar injection, message extraction, navigation
├── styles.css         # Sidebar UI styles (dark minimal theme)
├── popup.html         # Extension popup interface
├── popup.js           # Popup logic: tab detection, button actions
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## 🚀 Installation (Developer Mode)

1. **Open Chrome** and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the `threadpilot-extension/` folder
5. The ThreadPilot icon will appear in your Chrome toolbar

---

## 🧪 Usage

1. Go to **[chatgpt.com](https://chatgpt.com)** and open any conversation
2. Click the **ThreadPilot icon** in your toolbar, then click **"Open Navigator"**  
   *— or —*  
   Click the **tab icon** that appears on the right edge of the page  
   *— or —*  
   Press **`Alt + T`** to toggle the sidebar
3. Use the sidebar to:
   - Browse all extracted messages
   - Search with the search bar
   - Click any item to jump to that message
   - Press **Refresh** if new messages aren't showing

---

## 🎨 UI Overview

| Element | Description |
|---|---|
| **Header** | Logo + close button |
| **Stats bar** | Total messages · ❓ questions · 📌 key points |
| **Search** | Live filter for sidebar items |
| **Item list** | Scrollable list of extracted messages with emoji badges and role chips |
| **Footer** | Refresh + Summarize buttons |
| **Toggle button** | Fixed tab on the right edge of the page |

**Message type color coding:**
- `❓ Question` — yellow left border
- `📌 Key Info` — blue left border  
- `⭐ Detail` — green left border
- `💬 Prompt / 🤖 Response` — no accent border

---

## ⚙️ How It Works

### Message Detection
Uses `querySelectorAll('[data-message-author-role]')` to find all ChatGPT messages. This selector is stable across both `chatgpt.com` and `chat.openai.com`.

### Classification Rules
| Rule | Label |
|---|---|
| User message contains `?` | ❓ Question |
| Contains bullet/numbered list | 📌 Key Info |
| Assistant response > 200 chars | ⭐ Detail |
| Any other user message | 💬 Prompt |
| Any other assistant message | 🤖 Response |

### Title Generation
Strips markdown syntax (code fences, bold/italic markers, links), extracts the first sentence, and truncates to ~52 characters.

### Live Updates
A `MutationObserver` watches `document.body` for DOM changes. When new messages are added (e.g., during an active chat), the sidebar updates automatically with a 600ms debounce.

---

## 🔑 Keyboard Shortcut

| Shortcut | Action |
|---|---|
| `Alt + T` | Toggle sidebar open/closed |

---

## 🛠️ Tech Stack

- **Plain JavaScript** (no frameworks)
- **Chrome Extension Manifest V3**
- **Content Scripts + CSS injection**
- **MutationObserver** for live updates
- **No backend, no external APIs**

---

## 🗺️ Roadmap

- [ ] Real AI summarization (via OpenAI API key — user-supplied)
- [ ] Collapsible message sections by topic
- [ ] Export conversation outline to Markdown
- [ ] Light mode support
- [ ] Firefox / Edge support

---

## 📄 License

MIT — free to use, modify, and distribute.
