# Packaging Issues - Electron + Next.js Static Export

## TL;DR

Next.js static export with Electron creates routing issues for dynamic paths. **Architectural decision: Use state management instead of URL routing** to eliminate these issues entirely.

## Key Issues Identified

1. **Protocol Handler Bug**: `callback(filePath)` should be `callback({ path: filePath })`
2. **Asset Paths**: Need `assetPrefix: './'` in next.config.ts for relative paths  
3. **Dynamic Routing**: Static export can't handle `/notebook/[id]` routes
4. **IPC Error Handling**: Current implementation provides sufficient error handling

## Decision-Making Process

### Initial Approaches Considered

1. **Hash-based routing**: `file:///index.html#/notebook/123`
2. **Custom protocol**: `jeffers://app/notebook/123`  
3. **Local web server**: `http://localhost:3000/notebook/123`
4. **Pre-generate all routes**: Build HTML for every possible notebook ID
5. **State management**: Replace URL routing with React state

### Why State Management Won

- **Desktop UX Pattern**: Desktop apps don't rely on URLs for navigation
- **SQLite as Source of Truth**: UUIDs provide authoritative deep linking
- **Eliminates Complexity**: No routing workarounds needed
- **Better Performance**: Instant state changes vs URL parsing
- **Window-Specific**: Each Electron window maintains its own state
## Implementation Status

### Quick Fixes Assessment
1. **Protocol Handler**: Implemented. Uses `callback({ path: filePath })` format.
2. **Asset Prefix**: Implemented. `next.config.ts` includes conditional `assetPrefix` configuration.
3. **IPC Error Handling**: Current implementation uses optional chaining and type checking patterns. No changes needed.

### Current Architecture (state-mgmt branch)
The codebase implements a hybrid approach:
- Next.js App Router for top-level navigation (`/` to `/notebook/[id]`)
- State management via Zustand for complex window operations within notebooks
- IPC-backed persistence with proper error boundaries

### Architectural Decision Analysis

The document originally recommended pure state management over URL routing. The current implementation demonstrates a hybrid approach that maintains Next.js routing for simple navigation while using state management for complex operations.

#### **Rationale**

**Why State Management is Superior for Desktop Apps:**

1. **App-Level Deep Linking Through SQLite**
   - UUIDs serve as the authoritative reference system
   - `notebook UUID → Full notebook state from database`
   - `object UUID → Complete object with chunks, embeddings, etc.`
   - `chat UUID → Conversation history and context`
   - Everything restorable from persistent storage

2. **Desktop UX Patterns vs Web UX Patterns**
   - Desktop apps don't rely on URLs for navigation
   - Users interact through UI, not address bars
   - No need for sharing URLs, bookmarking, or browser back buttons
   - Window-specific state makes more sense than global URL state

3. **State Persistence That Actually Matters**
   - Last opened notebook ID stored in Zustand + IPC persistence
   - Window layout, scroll positions, active tabs
   - Search history, filters, preferences
   - All UUIDs reference permanent SQLite records

4. **Eliminates All Static Export Issues**
   - No need to generate static HTML for dynamic routes
   - No protocol interceptor workarounds
   - No asset path resolution issues
   - Simple, clean architecture

#### **Implementation Architecture**

```typescript
// Navigation is just state updates:
appStore.openNotebook(notebookUUID)  // Loads from database
appStore.openObject(objectUUID)      // Loads from database  
appStore.openChat(chatUUID)          // Loads from database

// On app launch:
const lastState = await window.api.getPersistedWindowState()
if (lastState.activeNotebookId) {
  appStore.openNotebook(lastState.activeNotebookId) // UUID from SQLite
}

// Simple state in a component or store
const [currentNotebook, setCurrentNotebook] = useState<string | null>(null);

// Navigation
const openNotebook = (id: string) => setCurrentNotebook(id);
const closeNotebook = () => setCurrentNotebook(null);

// Render
return currentNotebook ?
  <NotebookView notebookId={currentNotebook} /> :
  <HomeView />;
```

#### **Why This is Better Than URLs**

- **UUIDs don't break** (unlike file paths)
- **Rich state** (not just a string identifier) 
- **Offline-first** (no network dependencies)
- **Transactional consistency** with SQLite
- **Simple & Reliable** - No routing complexity whatsoever
- **Fast Navigation** - Instant state changes, no URL parsing
- **Desktop UX Pattern** - Most desktop apps don't show URLs anyway
- **Window-Specific State** - Each Electron window can have its own notebook state
- **Memory Efficient** - No router overhead or route matching

#### **Architecture Decision Record (ADR)**

**ADR-004: Use State Management Instead of URL Routing**
- **Status**: Accepted
- **Context**: Desktop applications have different UX patterns than web applications
- **Decision**: Use React state management for navigation instead of URL-based routing
- **Consequences**: 
  - ✅ Eliminates all static export routing issues
  - ✅ Provides faster, more reliable navigation
  - ✅ Better aligns with desktop UX patterns
  - ✅ SQLite becomes the authoritative source for deep linking
  - ❌ Loses URL-based sharing (not relevant for desktop apps)
  - ❌ No browser back button (confirmed as not needed)

### **Updated Recommended Approach**

For minimal disruption and maximum compatibility:

1. **State management routing** (NEW DECISION) - Replace URL routing entirely
2. **Build-time path resolution** (Option A) for assets  
3. **Keep current native module strategy** (it's working)
4. **IPC Proxy Pattern** (Option B) for better error handling

This combination:
- Eliminates all routing complexity
- Provides instant navigation
- Aligns with desktop app UX patterns  
- Uses SQLite as authoritative source of truth
- Maintains development velocity

The hash-based and server approaches are no longer needed since state management solves the core architectural mismatch between web frameworks and desktop applications.