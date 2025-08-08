"use client";

import { useState, useRef, useEffect } from "react";
import { Edit2, Globe } from "lucide-react";
import { Favicon } from "@/components/ui/Favicon";
import type { StoreApi } from "zustand";
import type { WindowStoreState } from "@/store/windowStoreFactory";
import type { WindowMeta, ClassicBrowserPayload } from "../../shared/types";

interface VerticalTabsProps {
  localWindow: WindowMeta;
  activeStore?: StoreApi<WindowStoreState>;
}

export function VerticalTabs({ localWindow, activeStore }: VerticalTabsProps) {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const handleTitleEdit = async () => {
    if (localWindow.type === 'classic-browser' && editedTitle.trim()) {
      const browserPayload = localWindow.payload as ClassicBrowserPayload;
      
      // Update the local state
      activeStore?.getState().updateWindowProps(localWindow.id, {
        payload: {
          ...browserPayload,
          tabGroupTitle: editedTitle.trim()
        }
      });
      
      // Call IPC to update backend
      if (browserPayload.tabGroupId) {
        await window.api.updateObject(browserPayload.tabGroupId, {
          title: editedTitle.trim()
        });
      }
    }
    setIsEditingTitle(false);
  };

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  if (localWindow.type === 'classic-browser') {
    const browserPayload = localWindow.payload as ClassicBrowserPayload;
    if (browserPayload.tabs && browserPayload.tabs.length > 1) {
      return (
        <div className="flex flex-col">
          {/* Tab group title header */}
          <div className="px-2 py-2">
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                onBlur={handleTitleEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleTitleEdit();
                  } else if (e.key === 'Escape') {
                    setIsEditingTitle(false);
                    setEditedTitle(browserPayload.tabGroupTitle || 'Thinking about a title...');
                  }
                }}
                className="w-full px-1 py-0.5 text-sm font-bold bg-transparent border border-step-6 rounded outline-none focus:border-step-8"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div 
                className="flex items-center justify-between group/title cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditedTitle(browserPayload.tabGroupTitle || 'Thinking about a title...');
                  setIsEditingTitle(true);
                }}
              >
                <span className="text-sm font-bold text-step-12">
                  {browserPayload.tabGroupTitle || 'Thinking about a title...'}
                </span>
                <Edit2 className="h-3 w-3 opacity-0 group-hover/title:opacity-50 transition-opacity" />
              </div>
            )}
          </div>
          
          {/* Tab list */}
          {browserPayload.tabs.map((tab) => (
            <div 
              key={tab.id} 
              className="px-2 py-1.5 text-sm text-step-11.5 dark:text-step-11 truncate rounded transition-colors hover:bg-step-1 hover:text-step-12 dark:hover:text-step-11.5 cursor-pointer group"
              onClick={async (e) => {
                e.stopPropagation();
                
                // Update the window state with the selected tab
                activeStore?.getState().updateWindowProps(localWindow.id, {
                  payload: {
                    ...browserPayload,
                    activeTabId: tab.id
                  }
                });
                
                // Add a small delay to ensure state update is processed
                // This allows the store update to propagate before restoration
                await new Promise(resolve => setTimeout(resolve, 50));
                
                // Restore the window (which will create browser with correct tab)
                activeStore?.getState().restoreWindow(localWindow.id);
              }}
            >
              <div className="flex items-center gap-2">
                {/* Tab favicon */}
                <Favicon 
                  url={tab.faviconUrl || undefined} 
                  fallback={<Globe className="h-4 w-4" />}
                  className="flex-shrink-0 h-4 w-4"
                />
                
                {/* Tab title */}
                <span className="truncate flex-1">
                  {tab.title || 'Untitled'}
                </span>
              </div>
            </div>
          ))}
        </div>
      );
    }
  }

  return (
    <div className="text-sm truncate">
      {localWindow.title}
    </div>
  );
}