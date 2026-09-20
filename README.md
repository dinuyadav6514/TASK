# ⚡ Task Terminal

A sleek, retro-styled Unix terminal shell for tracking tasks and projects directly in your browser. Features folder-based organization, custom task IDs, ASCII progress tracking, activity heatmaps, live trend charts, and **multi-device cloud synchronization with dedicated user accounts**.

---

## ☁️ Multi-Device Cloud Sync & User Accounts

Task Terminal supports dedicated user accounts backed by a cloud database (Upstash Redis / Vercel KV). Tasks you create on your desktop automatically sync to your phone, laptop, or any other browser you log into!

### Terminal Commands:
- `register <username> <password>`: Create a free cloud account. Your current tasks automatically sync.
- `login <username> <password>`: Log in on any device (phone, laptop, iPad, work PC) to immediately load your synced tasks.
- `logout`: Log out and return to local guest mode.
- `whoami`: Display current session username, user ID, and cloud sync status.
- `passwd <old_password> <new_password>`: Change your account password across all devices.
- `change_username <new_username> <password>`: Rename your username (all tasks are preserved).
- `delete_account <password> --confirm`: Permanently delete your cloud account and all cloud tasks.
- `sync`: Force an immediate push & pull sync with the cloud database.

*(If you don't log in, Task Terminal still works seamlessly in offline/guest mode using local browser storage).*

---

## 🚀 Deployment & Cloud Database Setup on Vercel

### Step 1: Deploy the Repo to Vercel
1. Push this repository to GitHub (`main` branch):
   ```bash
   git add .
   git commit -m "Add multi-device cloud sync and user accounts"
   git push origin main
   ```
2. Go to [vercel.com/new](https://vercel.com/new) and import your **TASK** repository.
3. Click **Deploy** (keep default settings).

### Step 2: Connect Free Cloud Database (1-Click)
To enable multi-device sync across all your devices:
1. In your project page on the [Vercel Dashboard](https://vercel.com/dashboard), click the **Storage** tab.
2. Click **Create Database** &rarr; select **KV** (or **Upstash Redis** from Marketplace).
3. Click **Continue** &rarr; select **Free tier** &rarr; click **Create**.
4. Vercel automatically links the database and injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
5. Redeploy (or trigger a new deploy) — that's it! Your Task Terminal now has full cloud sync enabled.

---

## 🛠 Features

- **Retro CRT Aesthetic**: Scanline effects, CRT vignette, responsive layout, and crisp typography powered by JetBrains Mono.
- **Dedicated User Authentication**: Multi-device sync with secure password hashing (PBKDF2 SHA-512) and session tokens.
- **Directory Hierarchy**: Organize tasks in nested categories (e.g., `company/`, `GATE/MATH/`, `frontend/`) using standard `mkdir`, `cd`, `pwd`, and `ls`.
- **Fast Task Management**:
  - `touch "Task Name" #id t1` to create and assign short IDs.
  - `progress <id> <0-100>` to update progress with animated gradient bars.
  - `status <id> <pending|progress|done|overdue>` to manage lifecycle.
  - `due <id> <YYYY-MM-DD|none>` to set milestones and deadlines.
  - `echo "Note" >> <id>` to log timestamped activity notes.
- **Visual Analytics**:
  - `cat <id>` renders completion curves and a GitHub-style 30-day activity heatmap.
  - `tasks --tree` (or `tree`) prints a directory tree flowchart.
  - `stats` renders an ASCII overview of task distribution.
- **Storage Options**:
  - **Cloud Sync**: Auto-syncs across any device when logged in.
  - **Local Disk Sync**: Link directly to a `tasks_data.json` file on your computer via File System Access API.
  - **Local Browser Storage**: Automatic offline fallback.
  - **Import & Export**: Use `export` to download a JSON backup or `import` to restore it.

---

## ⌨️ Command Reference

| Command | Arguments | Description |
|---|---|---|
| `register` / `signup` | `<user> <pass>` | Create a cloud account and sync tasks across devices |
| `login` / `signin` | `<user> <pass>` | Log into your account from any phone or computer |
| `logout` | | Sign out and return to guest mode |
| `whoami` | | Display current user, session, and sync state |
| `passwd` | `<old> <new>` | Change your cloud account password |
| `change_username` | `<new> <pass>` | Rename your account username (tasks preserved) |
| `delete_account` | `<pass> --confirm` | Permanently delete account and all cloud tasks |
| `sync` | | Manually sync local and cloud databases |
| `help` / `?` | | Display all available terminal commands |
| `man` | `<command>` | View manual page, synopsis, and examples for a command |
| `ls` | `[-l] [dir]` | List category folders & tasks (use `-l` for detailed table) |
| `tasks` | `[--tree\|--table]` | View directory-grouped task overview |
| `tree` / `flowchart` | | Display flowchart tree of folders & tasks |
| `touch` | `<name> [#id <id>]` | Create a task / assign a custom short ID |
| `cat` | `<task\|id>` | Detailed view with trend chart, heatmap & activity logs |
| `rm` | `[-r] <task\|folder>` | Remove a task or directory (`-r` for recursive) |
| `cp` | `<src> <dest>` | Duplicate a task |
| `mv` | `<src> <dest>` | Move task into folder, change status, or rename |
| `id` | `task <name> as <id>` | Set custom short ID (e.g. `t1`, `m2`) |
| `progress` | `<task\|id> <0-100>` | Set completion percentage |
| `status` | `<task\|id> <status>` | Set status: `pending`, `progress`, `done`, `overdue` |
| `due` | `<task\|id> <YYYY-MM-DD>`| Set deadline or `none` to clear |
| `note` | `<task\|id> <text>` | Add note entry to task history |
| `echo` | `"<text>" >> <task>` | Append note to task |
| `grep` | `<pattern>` | Search across tasks, categories, notes, and history |
| `mkdir` | `<folder>` | Create a new task category folder |
| `rmdir` | `<folder>` | Remove an empty category folder |
| `cd` | `<folder\|..\|~>` | Navigate into a category or status filter |
| `pwd` | | Print current directory path |
| `ps` / `top` | | Process table of active & in-progress tasks |
| `df` | `[-h]` | Show filesystem storage and linking status |
| `cal` / `date` | | Display calendar and current date/time |
| `stats` | | Overview dashboard with status charts |
| `export` / `download` | | Export workspace as `tasks_data.json` |
| `import` / `upload` | | Import and restore tasks from a JSON backup file |
| `reset` / `reload` | `[--confirm]` | Reset tasks to default server template |
| `theme` / `mode` | `[light\|dark]` | Switch terminal between light and dark themes (or toggle) |
| `link` | | Link `tasks_data.json` on disk (File System Access API) |
| `clear` / `cls` | | Clear terminal screen |

---

## 📁 Project Structure

```
├── api/
│   ├── auth.js        # Serverless API: /api/auth (register, login, me)
│   ├── tasks.js       # Serverless API: /api/tasks (GET / POST user tasks)
│   └── lib/
│       └── db.js      # Upstash Redis client, PBKDF2 hashing, session tokens
├── test/
│   └── api-test.js    # Automated integration test suite
├── index.html         # Main entry point (served at / by Vercel)
├── tasks.html         # Compatibility redirect bridge
├── tasks.css          # Terminal UI, CRT overlay, responsive layout
├── tasks.js           # Core terminal engine, auth flow, persistence
├── tasks_data.json    # Starter template / portable JSON schema
├── vercel.json        # Vercel routing, clean URLs & cache configuration
├── package.json       # Node package descriptor
├── .gitignore         # Git ignore rules
└── README.md          # Documentation
```

---

## 📄 License

MIT
