// Lightweight context menu overlay script
import type { BrowserContextMenuData } from '../../shared/types/contextMenu.types';

interface MenuAction {
  windowId: string;
  action: string;
  context: BrowserContextMenuData;
}

interface MenuItem {
  label: string;
  action: string;
  enabled: boolean;
  type?: 'separator';
}

interface ActionData {
  url?: string;
  query?: string;
  x?: number;
  y?: number;
  background?: boolean;
}

// Extend window interface for overlay instance
declare global {
  interface Window {
    overlayInstance: ContextMenuOverlay;
  }
}

class ContextMenuOverlay {
  private windowId: string | null = null;
  private contextMenuData: BrowserContextMenuData | null = null;
  private menuElement: HTMLDivElement | null = null;
  private root: HTMLElement;
  private isShowingNewMenu: boolean = false;

  constructor() {
    // Get window ID from IPC - will be sent after page loads
    this.windowId = null;
    
    this.root = document.getElementById('context-menu-root')!;
    this.setupStyles();
    this.setupListeners();
    this.notifyReady();
  }

  private setupStyles(): void {
    // Set up transparent background
    Object.assign(document.body.style, {
      backgroundColor: 'transparent',
      pointerEvents: 'none',
      margin: '0',
      padding: '0',
      overflow: 'hidden',
      position: 'fixed',
      inset: '0'
    });

    // Add color system CSS variables and font faces
    const style = document.createElement('style');
    style.textContent = `
      @font-face {
        font-family: 'Soehne';
        src: url('./fonts/soehne-buch.woff2') format('woff2');
        font-weight: 400;
        font-style: normal;
        font-display: swap;
      }
      
      @font-face {
        font-family: 'Soehne';
        src: url('./fonts/soehne-kraftig.woff2') format('woff2');
        font-weight: 500;
        font-style: normal;
        font-display: swap;
      }
      
      :root {
        /* Light mode colors */
        --step-1: #fdfdfc;
        --step-3: #f1f0ef;
        --step-6: #dad9d6;
        --step-11-5: #51504B;
      }
      
      @media (prefers-color-scheme: dark) {
        :root {
          /* Dark mode colors */
          --step-1: #111110;
          --step-3: #222221;
          --step-6: #3b3a37;
          --step-11-5: #D0CFCA;
        }
      }
      
      .dark {
        /* Dark mode colors when explicitly set */
        --step-1: #111110;
        --step-3: #222221;
        --step-6: #3b3a37;
        --step-11-5: #D0CFCA;
      }
    `;
    document.head.appendChild(style);
  }

  private setupListeners(): void {
    // Listen for context menu data from main process
    if (window.api?.browserContextMenu) {
      window.api.browserContextMenu.onShow((data: BrowserContextMenuData) => {
        this.showContextMenu(data);
      });

      // Note: We don't listen for hide events from main process to avoid circular loops
      // The overlay manages its own hide behavior through click/escape handlers
    }

    // Handle clicks outside the menu
    document.addEventListener('click', (e) => {
      if (this.menuElement && !this.menuElement.contains(e.target as Node)) {
        this.hideContextMenu();
      }
    });

    // Handle escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideContextMenu();
      }
    });
  }

  private notifyReady(): void {
    if (window.api?.browserContextMenu?.notifyReady) {
      window.api.browserContextMenu.notifyReady();
    }
  }

  public setWindowId(windowId: string): void {
    this.windowId = windowId;
  }

  private showContextMenu(data: BrowserContextMenuData): void {
    // Hide any existing menu without notifying (we're about to show a new one)
    this.isShowingNewMenu = true;
    this.hideContextMenu();
    this.isShowingNewMenu = false;

    // Set the context menu data after hiding the old menu
    this.contextMenuData = data;

    // Create menu container
    this.menuElement = document.createElement('div');
    this.menuElement.className = 'browser-context-menu';
    this.menuElement.style.cssText = `
      position: fixed;
      left: ${data.x}px;
      top: ${data.y}px;
      background: var(--step-1);
      border: 1px solid var(--step-3);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      padding: 4px 0;
      min-width: 200px;
      z-index: 10000;
      pointer-events: auto;
      font-family: 'Soehne', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    // Create menu items based on context
    const items = this.getMenuItems(data);
    
    items.forEach((item) => {
      if (item.type === 'separator') {
        const separator = document.createElement('div');
        separator.style.cssText = `
          height: 1px;
          background: var(--step-6);
          margin: 4px 8px;
        `;
        this.menuElement!.appendChild(separator);
      } else {
        const menuItem = document.createElement('div');
        menuItem.className = 'menu-item';
        menuItem.textContent = item.label;
        menuItem.style.cssText = `
          padding: 8px 16px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 400;
          color: var(--step-11-5);
          white-space: nowrap;
          user-select: none;
          transition: background-color 0.1s ease;
        `;

        if (item.enabled === false) {
          menuItem.style.opacity = '0.4';
          menuItem.style.cursor = 'default';
        } else {
          menuItem.addEventListener('mouseenter', () => {
            menuItem.style.backgroundColor = 'var(--step-3)';
          });
          menuItem.addEventListener('mouseleave', () => {
            menuItem.style.backgroundColor = 'transparent';
          });
          menuItem.addEventListener('click', () => {
            this.handleMenuClick(item.action);
          });
        }

        this.menuElement!.appendChild(menuItem);
      }
    });

    // Add to DOM
    this.root.appendChild(this.menuElement);

    // Adjust position if menu would go off-screen
    requestAnimationFrame(() => {
      if (!this.menuElement) return;
      
      const rect = this.menuElement.getBoundingClientRect();
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      if (rect.right > windowWidth) {
        this.menuElement.style.left = `${Math.max(0, data.x - rect.width)}px`;
      }
      if (rect.bottom > windowHeight) {
        this.menuElement.style.top = `${Math.max(0, data.y - rect.height)}px`;
      }
    });
  }

  private hideContextMenu(): void {
    if (this.menuElement) {
      this.menuElement.remove();
      this.menuElement = null;
    }
    this.contextMenuData = null;
    
    // Only notify main process if we're not about to show a new menu
    if (!this.isShowingNewMenu && window.api?.browserContextMenu?.notifyClosed) {
      window.api.browserContextMenu.notifyClosed(this.windowId);
    }
  }

  private getMenuItems(data: BrowserContextMenuData): MenuItem[] {
    const items: MenuItem[] = [];

    // Handle tab context menu
    if (data.contextType === 'tab' && data.tabContext) {
      const tabCtx = data.tabContext;
      items.push(
        { label: 'Close tab', action: 'close', enabled: tabCtx.canClose }
      );
      return items;
    }

    // Only show browser context menu items if we have browser context
    if (!data.browserContext) {
      return items;
    }

    const ctx = data.browserContext;

    // Link context menu
    if (ctx.linkURL) {
      items.push(
        { label: 'Open link in a new tab', action: 'openInNewTab', enabled: true },
        { label: 'Open link in a new window', action: 'openInBackground', enabled: true },
        { type: 'separator' } as MenuItem,
        { label: 'Copy link', action: 'copyLink', enabled: true }
      );
    }

    // Image context menu
    if (ctx.srcURL && ctx.mediaType === 'image') {
      if (items.length > 0) items.push({ type: 'separator' } as MenuItem);
      items.push(
        { label: 'Open image in a new tab', action: 'openImageInNewTab', enabled: true },
        { label: 'Copy image URL', action: 'copyImageURL', enabled: true },
        { label: 'Save image as...', action: 'saveImageAs', enabled: true }
      );
    }

    // Text selection context menu
    if (ctx.selectionText) {
      if (items.length > 0) items.push({ type: 'separator' } as MenuItem);
      const truncatedText = ctx.selectionText.substring(0, 20) + (ctx.selectionText.length > 20 ? '...' : '');
      items.push(
        { label: 'Copy', action: 'copy', enabled: ctx.editFlags.canCopy },
        { label: `Search for "${truncatedText}"`, action: 'searchSelection', enabled: true }
      );
    }

    // Editable context menu (input fields, textareas, contenteditable elements)
    if (ctx.isEditable) {
      if (items.length > 0) items.push({ type: 'separator' } as MenuItem);
      
      // Add standard edit options for editable contexts
      const editItems: MenuItem[] = [];
      
      if (ctx.editFlags.canUndo) {
        editItems.push({ label: 'Undo', action: 'undo', enabled: true });
      }
      if (ctx.editFlags.canRedo) {
        editItems.push({ label: 'Redo', action: 'redo', enabled: true });
      }
      
      if (editItems.length > 0) {
        items.push(...editItems);
        items.push({ type: 'separator' } as MenuItem);
      }
      
      // Add cut/copy/paste/select all
      if (ctx.editFlags.canCut) {
        items.push({ label: 'Cut', action: 'cut', enabled: true });
      }
      if (ctx.editFlags.canCopy) {
        items.push({ label: 'Copy', action: 'copy', enabled: true });
      }
      if (ctx.editFlags.canPaste) {
        items.push({ label: 'Paste', action: 'paste', enabled: true });
      }
      if (ctx.editFlags.canSelectAll) {
        items.push({ label: 'Select all', action: 'selectAll', enabled: true });
      }
    }

    // Page context menu (when nothing specific is clicked)
    if (items.length === 0) {
      items.push(
        { label: 'Back', action: 'goBack', enabled: ctx.canGoBack ?? false },
        { label: 'Forward', action: 'goForward', enabled: ctx.canGoForward ?? false },
        { label: 'Reload', action: 'reload', enabled: true },
        { type: 'separator' } as MenuItem,
        { label: 'Copy page URL', action: 'copyPageURL', enabled: true },
        { label: 'View page source', action: 'viewSource', enabled: true }
      );
    }

    // Always add inspect element at the end
    items.push(
      { type: 'separator' } as MenuItem,
      { label: 'Inspect element', action: 'inspect', enabled: true }
    );

    return items;
  }

  private handleMenuClick(action: string): void {
    if (!this.windowId || !this.contextMenuData) return;

    // Handle tab actions directly through IPC (like the React component does)
    if (this.contextMenuData.contextType === 'tab' && this.contextMenuData.tabContext) {
      this.handleTabAction(action, this.contextMenuData.tabContext.tabId);
      this.hideContextMenu();
      return;
    }

    // Handle browser context actions through the context menu system
    const { mappedAction, actionData } = this.mapActionAndData(action, this.contextMenuData);

    // Send action to main process
    if (window.api?.browserContextMenu?.sendAction) {
      const menuAction: MenuAction = {
        windowId: this.windowId,
        action: mappedAction,
        context: this.contextMenuData
      };
      const fullPayload = { ...menuAction, ...actionData };
      window.api.browserContextMenu.sendAction(mappedAction, fullPayload);
    }

    // Hide menu after action
    this.hideContextMenu();
  }

  private async handleTabAction(action: string, tabId: string): Promise<void> {
    if (!this.windowId) return;

    switch (action) {
      case 'close':
        await window.api?.classicBrowserCloseTab?.(this.windowId, tabId);
        break;
    }
  }

  private mapActionAndData(action: string, contextData: BrowserContextMenuData): { mappedAction: string; actionData: ActionData } {
    const browserContext = contextData.browserContext;
    
    switch (action) {
      // Link actions
      case 'openInNewTab':
        return {
          mappedAction: 'link:open-new-tab',
          actionData: { url: browserContext?.linkURL || '' }
        };
      case 'openInBackground':
        return {
          mappedAction: 'link:open-background',
          actionData: { url: browserContext?.linkURL || '' }
        };
      case 'copyLink':
        return {
          mappedAction: 'link:copy',
          actionData: { url: browserContext?.linkURL || '' }
        };

      // Image actions
      case 'openImageInNewTab':
        return {
          mappedAction: 'image:open-new-tab',
          actionData: { url: browserContext?.srcURL || '' }
        };
      case 'copyImageURL':
        return {
          mappedAction: 'image:copy-url',
          actionData: { url: browserContext?.srcURL || '' }
        };
      case 'saveImageAs':
        return {
          mappedAction: 'image:save',
          actionData: { url: browserContext?.srcURL || '' }
        };

      // Text selection actions
      case 'copy':
        return {
          mappedAction: 'edit:copy',
          actionData: {}
        };
      case 'searchSelection':
        return {
          mappedAction: 'search:enai',
          actionData: { query: browserContext?.selectionText || '' }
        };

      // Edit actions
      case 'undo':
        return {
          mappedAction: 'edit:undo',
          actionData: {}
        };
      case 'redo':
        return {
          mappedAction: 'edit:redo',
          actionData: {}
        };
      case 'cut':
        return {
          mappedAction: 'edit:cut',
          actionData: {}
        };
      case 'paste':
        return {
          mappedAction: 'edit:paste',
          actionData: {}
        };
      case 'selectAll':
        return {
          mappedAction: 'edit:select-all',
          actionData: {}
        };

      // Navigation actions
      case 'goBack':
        return {
          mappedAction: 'navigate:back',
          actionData: {}
        };
      case 'goForward':
        return {
          mappedAction: 'navigate:forward',
          actionData: {}
        };
      case 'reload':
        return {
          mappedAction: 'navigate:reload',
          actionData: {}
        };

      // Page actions
      case 'copyPageURL':
        return {
          mappedAction: 'page:copy-url',
          actionData: { url: browserContext?.pageURL || '' }
        };
      case 'viewSource':
        return {
          mappedAction: 'dev:view-source',
          actionData: {}
        };
      case 'inspect':
        return {
          mappedAction: 'dev:inspect',
          actionData: { x: contextData.x, y: contextData.y }
        };

      // Default fallback
      default:
        return {
          mappedAction: action,
          actionData: {}
        };
    }
  }
}

// Initialize overlay when DOM is ready
let overlayInstance: ContextMenuOverlay;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    overlayInstance = new ContextMenuOverlay();
    window.overlayInstance = overlayInstance;
  });
} else {
  overlayInstance = new ContextMenuOverlay();
  window.overlayInstance = overlayInstance;
}