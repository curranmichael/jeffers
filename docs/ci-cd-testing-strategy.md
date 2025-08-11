# Testing Strategy

## Overview

Enai has a comprehensive test suite with **78 test files** across 5 categories, designed to ensure reliability across the full stack from database operations to React components.

## Test Categories

### 1. Models Tests (12 files)
**Purpose**: Database layer validation
- **Location**: `models/_tests/`
- **Technology**: SQLite with better-sqlite3
- **What's tested**: CRUD operations, migrations, data integrity
- **Examples**:
  - `ChatModel.test.ts` - Message persistence and retrieval
  - `ObjectModelCore.test.ts` - Core object operations
  - `LanceVectorModel.test.ts` - Vector database operations

### 2. Services Tests (45 files)
**Purpose**: Business logic validation
- **Location**: `services/_tests/`, `services/*/tests/`
- **Technology**: Unit tests with mocks
- **What's tested**: Service methods, error handling, integrations
- **Examples**:
  - `ChatService.test.ts` - Chat message processing
  - `HybridSearchService.test.ts` - Multi-source search coordination
  - `AgentService.test.ts` - AI agent orchestration
  - `ExaService.test.ts` - External API integration

### 3. IPC/Electron Tests (8 files)  
**Purpose**: Inter-process communication validation
- **Location**: `electron/ipc/_tests/`
- **Technology**: Electron IPC mocking
- **What's tested**: Main↔Renderer communication, handlers
- **Examples**:
  - `chatStreamHandler.test.ts` - Streaming chat responses
  - `classicBrowserHandlers.test.ts` - Browser control IPC

### 4. Component Tests (8 files)
**Purpose**: React component behavior validation
- **Location**: `src/components/**/_tests/`
- **Technology**: React Testing Library + jsdom
- **What's tested**: User interactions, rendering, props
- **Examples**:
  - `ClassicBrowser.test.tsx` - Browser component behavior
  - `NoteEditor.test.tsx` - Note editing functionality

### 5. Integration Tests (5 files)
**Purpose**: End-to-end workflow validation
- **Location**: Various (`electron/_tests/integration/`, `src/app/**/_tests/`)
- **Technology**: Multi-layer test setup
- **What's tested**: Complete user workflows
- **Examples**:
  - `classic-browser.integration.test.ts` - Full browser workflow

## Test Configuration

### Environments
- **Unit/Service Tests**: jsdom environment
- **Storybook Tests**: Real browser (Playwright + Chromium)

### Key Dependencies
- **Framework**: Vitest 3.1.3 
- **React Testing**: @testing-library/react
- **Browser Testing**: Playwright (for Storybook)
- **Database**: SQLite in-memory (`:memory:`)

### Performance Characteristics
- **Total Tests**: ~287 individual test cases
- **Typical Runtime**: 2-5 minutes for full suite
- **Database Tests**: Require better-sqlite3 native rebuild after Node version changes
- **Heavy Tests**: Some ingestion tests have 15-minute timeouts

## CI Strategy (Implemented)

Our GitHub Actions workflow (`.github/workflows/test.yml`) implements a **3-tier testing approach** that balances speed and coverage:

### 🚀 Core Tests (Every PR + Push)
**Triggers**: All pull requests and pushes to main
**Runtime**: ~2-3 minutes
**What runs**:
- All model tests (database layer)
- Core service tests (ChatService, NotebookService, etc.)
- Base service infrastructure tests
- Excludes external API tests

**Purpose**: Fast feedback loop for developers

### 🔄 Extended Tests (Push to main only)
**Triggers**: Push to main OR when test files change in PR
**Runtime**: ~8-12 minutes  
**What runs**:
- All service tests (excluding external APIs like ExaService)
- All IPC handler tests
- All React component tests
- Excludes integration tests and Storybook tests

**Purpose**: Comprehensive validation before merging

### ⚡ TypeCheck (Every PR + Push)
**Triggers**: All pull requests and pushes to main
**Runtime**: ~1-2 minutes
**What runs**:
- TypeScript compilation check
- ESLint code quality checks

**Purpose**: Catch syntax and type errors immediately

### ❌ Excluded from CI
- **Storybook visual tests** - Require Playwright browser download (~280MB)
- **External API tests** - Need real API keys (ExaService, IngestionAIService, AgentService)
- **Integration tests** - Long-running, complex setup
- **Performance tests** - Resource intensive

## External Dependencies

### Required Environment Variables
- `OPENAI_API_KEY` - For AI service tests
- `EXA_API_KEY` - For web search tests (optional, tests skip if missing)

### Recommendations
1. **Mock external services** in CI rather than use real API keys
2. **Use test API keys** in a separate test environment if needed
3. **Skip external tests** by default, run in separate workflow

## Test Maintenance

### Common Issues
1. **better-sqlite3 rebuild** - Run `npm rebuild better-sqlite3` after Node version changes
2. **Timeout errors** - Some tests have very long timeouts (15min default)
3. **Race conditions** - Integration tests may need coordination

### Development Workflow
```bash
# Fast feedback loop
npm test services/_tests/ExaService.test.ts

# Full service layer
npx vitest run services/

# Everything  
npm test
```

## Performance Notes

The test suite includes some resource-intensive tests:
- **Vector database operations** - LanceDB queries can be slow
- **PDF processing tests** - File I/O and parsing
- **Browser integration tests** - Multi-component coordination

Consider splitting these into separate CI jobs for better parallelization.