"use strict";(()=>{var i=class{constructor(){this.windowId=null;this.contextMenuData=null;this.menuElement=null;this.isShowingNewMenu=!1;this.windowId=null,this.root=document.getElementById("context-menu-root"),this.setupStyles(),this.setupListeners(),this.notifyReady()}setupStyles(){Object.assign(document.body.style,{backgroundColor:"transparent",pointerEvents:"none",margin:"0",padding:"0",overflow:"hidden",position:"fixed",inset:"0"});let n=document.createElement("style");n.textContent=`
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
    `,document.head.appendChild(n)}setupListeners(){window.api?.browserContextMenu&&window.api.browserContextMenu.onShow(n=>{this.showContextMenu(n)}),document.addEventListener("click",n=>{this.menuElement&&!this.menuElement.contains(n.target)&&this.hideContextMenu()}),document.addEventListener("keydown",n=>{n.key==="Escape"&&this.hideContextMenu()})}notifyReady(){window.api?.browserContextMenu?.notifyReady&&window.api.browserContextMenu.notifyReady()}setWindowId(n){this.windowId=n}showContextMenu(n){this.isShowingNewMenu=!0,this.hideContextMenu(),this.isShowingNewMenu=!1,this.contextMenuData=n,this.menuElement=document.createElement("div"),this.menuElement.className="browser-context-menu",this.menuElement.style.cssText=`
      position: fixed;
      left: ${n.x}px;
      top: ${n.y}px;
      background: var(--step-1);
      border: 1px solid var(--step-3);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      padding: 4px 0;
      min-width: 200px;
      z-index: 10000;
      pointer-events: auto;
      font-family: 'Soehne', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `,this.getMenuItems(n).forEach(e=>{if(e.type==="separator"){let a=document.createElement("div");a.style.cssText=`
          height: 1px;
          background: var(--step-6);
          margin: 4px 8px;
        `,this.menuElement.appendChild(a)}else{let a=document.createElement("div");a.className="menu-item",a.textContent=e.label,a.style.cssText=`
          padding: 8px 16px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 400;
          color: var(--step-11-5);
          white-space: nowrap;
          user-select: none;
          transition: background-color 0.1s ease;
        `,e.enabled===!1?(a.style.opacity="0.4",a.style.cursor="default"):(a.addEventListener("mouseenter",()=>{a.style.backgroundColor="var(--step-3)"}),a.addEventListener("mouseleave",()=>{a.style.backgroundColor="transparent"}),a.addEventListener("click",()=>{this.handleMenuClick(e.action)})),this.menuElement.appendChild(a)}}),this.root.appendChild(this.menuElement),requestAnimationFrame(()=>{if(!this.menuElement)return;let e=this.menuElement.getBoundingClientRect(),a=window.innerWidth,s=window.innerHeight;e.right>a&&(this.menuElement.style.left=`${Math.max(0,n.x-e.width)}px`),e.bottom>s&&(this.menuElement.style.top=`${Math.max(0,n.y-e.height)}px`)})}hideContextMenu(){this.menuElement&&(this.menuElement.remove(),this.menuElement=null),this.contextMenuData=null,!this.isShowingNewMenu&&window.api?.browserContextMenu?.notifyClosed&&window.api.browserContextMenu.notifyClosed(this.windowId)}getMenuItems(n){let t=[];if(n.contextType==="tab"&&n.tabContext){let a=n.tabContext;return t.push({label:"Close tab",action:"close",enabled:a.canClose}),t}if(!n.browserContext)return t;let e=n.browserContext;if(e.linkURL&&t.push({label:"Open link in a new tab",action:"openInNewTab",enabled:!0},{label:"Open link in a new window",action:"openInBackground",enabled:!0},{type:"separator"},{label:"Copy link",action:"copyLink",enabled:!0}),e.srcURL&&e.mediaType==="image"&&(t.length>0&&t.push({type:"separator"}),t.push({label:"Open image in a new tab",action:"openImageInNewTab",enabled:!0},{label:"Copy image URL",action:"copyImageURL",enabled:!0},{label:"Save image as...",action:"saveImageAs",enabled:!0})),e.selectionText){t.length>0&&t.push({type:"separator"});let a=e.selectionText.substring(0,20)+(e.selectionText.length>20?"...":"");t.push({label:"Copy",action:"copy",enabled:e.editFlags.canCopy},{label:`Search for "${a}"`,action:"searchSelection",enabled:!0})}if(e.isEditable){t.length>0&&t.push({type:"separator"});let a=[];e.editFlags.canUndo&&a.push({label:"Undo",action:"undo",enabled:!0}),e.editFlags.canRedo&&a.push({label:"Redo",action:"redo",enabled:!0}),a.length>0&&(t.push(...a),t.push({type:"separator"})),e.editFlags.canCut&&t.push({label:"Cut",action:"cut",enabled:!0}),e.editFlags.canCopy&&t.push({label:"Copy",action:"copy",enabled:!0}),e.editFlags.canPaste&&t.push({label:"Paste",action:"paste",enabled:!0}),e.editFlags.canSelectAll&&t.push({label:"Select all",action:"selectAll",enabled:!0})}return t.length===0&&t.push({label:"Back",action:"goBack",enabled:e.canGoBack??!1},{label:"Forward",action:"goForward",enabled:e.canGoForward??!1},{label:"Reload",action:"reload",enabled:!0},{type:"separator"},{label:"Copy page URL",action:"copyPageURL",enabled:!0},{label:"View page source",action:"viewSource",enabled:!0}),t.push({type:"separator"},{label:"Inspect element",action:"inspect",enabled:!0}),t}handleMenuClick(n){if(!this.windowId||!this.contextMenuData)return;if(this.contextMenuData.contextType==="tab"&&this.contextMenuData.tabContext){this.handleTabAction(n,this.contextMenuData.tabContext.tabId),this.hideContextMenu();return}let{mappedAction:t,actionData:e}=this.mapActionAndData(n,this.contextMenuData);if(window.api?.browserContextMenu?.sendAction){let s={...{windowId:this.windowId,action:t,context:this.contextMenuData},...e};window.api.browserContextMenu.sendAction(t,s)}this.hideContextMenu()}async handleTabAction(n,t){if(this.windowId)switch(n){case"close":await window.api?.classicBrowserCloseTab?.(this.windowId,t);break}}mapActionAndData(n,t){let e=t.browserContext;switch(n){case"openInNewTab":return{mappedAction:"link:open-new-tab",actionData:{url:e?.linkURL||""}};case"openInBackground":return{mappedAction:"link:open-background",actionData:{url:e?.linkURL||""}};case"copyLink":return{mappedAction:"link:copy",actionData:{url:e?.linkURL||""}};case"openImageInNewTab":return{mappedAction:"image:open-new-tab",actionData:{url:e?.srcURL||""}};case"copyImageURL":return{mappedAction:"image:copy-url",actionData:{url:e?.srcURL||""}};case"saveImageAs":return{mappedAction:"image:save",actionData:{url:e?.srcURL||""}};case"copy":return{mappedAction:"edit:copy",actionData:{}};case"searchSelection":return{mappedAction:"search:enai",actionData:{query:e?.selectionText||""}};case"undo":return{mappedAction:"edit:undo",actionData:{}};case"redo":return{mappedAction:"edit:redo",actionData:{}};case"cut":return{mappedAction:"edit:cut",actionData:{}};case"paste":return{mappedAction:"edit:paste",actionData:{}};case"selectAll":return{mappedAction:"edit:select-all",actionData:{}};case"goBack":return{mappedAction:"navigate:back",actionData:{}};case"goForward":return{mappedAction:"navigate:forward",actionData:{}};case"reload":return{mappedAction:"navigate:reload",actionData:{}};case"copyPageURL":return{mappedAction:"page:copy-url",actionData:{url:e?.pageURL||""}};case"viewSource":return{mappedAction:"dev:view-source",actionData:{}};case"inspect":return{mappedAction:"dev:inspect",actionData:{x:t.x,y:t.y}};default:return{mappedAction:n,actionData:{}}}}},o;document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>{o=new i,window.overlayInstance=o}):(o=new i,window.overlayInstance=o);})();
//# sourceMappingURL=overlay.js.map
