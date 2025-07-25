"use client";

import { Home, MessageSquare, Globe, MonitorIcon, FileText, LucideIcon } from "lucide-react";
import { NoteEditorPayload, WindowContentType } from "../../shared/types";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarSeparator,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Favicon } from "@/components/ui/Favicon";
import { TabFaviconStack } from "@/components/ui/TabFaviconStack";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { StoreApi } from "zustand";
import type { WindowStoreState } from "@/store/windowStoreFactory";
import type { WindowMeta, ClassicBrowserPayload } from "../../shared/types";

// Window type to icon mapping
const WINDOW_TYPE_ICONS: Record<WindowContentType, LucideIcon> = {
  'placeholder': MonitorIcon,
  'empty': MonitorIcon,
  'chat': MessageSquare,
  'browser': Globe,
  'classic-browser': Globe,
  'notebook_raw_editor': FileText,
  'note_editor': FileText,
};

interface AppSidebarProps {
  onAddChat: () => void;
  onAddBrowser: () => void;
  onGoHome: () => void;
  windows?: WindowMeta[];
  activeStore?: StoreApi<WindowStoreState>;
  notebookId?: string;
}

export function AppSidebar({ onAddChat, onAddBrowser, onGoHome, windows = [], activeStore, notebookId }: AppSidebarProps) {
  const minimizedWindows = windows.filter(w => w.isMinimized);
  
  const handleNewNote = () => {
    if (!activeStore || !notebookId) return;
    
    const payload: NoteEditorPayload = {
      notebookId,
    };
    
    activeStore.getState().addWindow({
      type: 'note_editor' as WindowContentType,
      payload,
      preferredMeta: {
        title: 'New Note',
        width: 600,
        height: 400,
      }
    });
  };
  
  
  return (
    <Sidebar side="right" variant="floating" className="bg-step-1 border-step-6 p-1" collapsible="icon">
      <SidebarRail />
      <SidebarHeader className="py-4 px-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton 
              onClick={onGoHome} 
              className="justify-start"
              tooltip="Go to Home"
            >
              <Home className="h-4 w-4 text-step-10 hover:text-birkin" />
              <span>Home</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      
      <SidebarContent>
        <SidebarSeparator className="bg-step-6" />
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton 
                  onClick={onAddChat} 
                  tooltip="Add New Chat"
                >
                  <MessageSquare className="h-4 w-4 text-step-10 hover:text-birkin" />
                  <span>New Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton 
                  onClick={onAddBrowser} 
                  tooltip="Surf the Web"
                >
                  <Globe className="h-4 w-4 text-step-10 hover:text-birkin" />
                  <span>Surf the web</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton 
                  onClick={handleNewNote} 
                  tooltip="Write a Note"
                >
                  <FileText className="h-4 w-4 text-step-10 hover:text-birkin" />
                  <span>Write a note</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        
        {minimizedWindows.length > 0 && (
          <>
            <SidebarSeparator className="bg-step-6" />
            <SidebarGroup>
              <SidebarGroupLabel>Minimized Windows</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {minimizedWindows.map((localWindow) => {
                    const renderIcon = () => {
                      // Special handling for classic-browser windows with favicons
                      if (localWindow.type === 'classic-browser') {
                        const browserPayload = localWindow.payload as ClassicBrowserPayload;
                        
                        // Use TabFaviconStack for multi-tab windows
                        if (browserPayload.tabs && browserPayload.tabs.length > 1) {
                          return (
                            <TabFaviconStack
                              tabs={browserPayload.tabs}
                              activeTabId={browserPayload.activeTabId}
                            />
                          );
                        }
                        
                        // Single tab or no tabs - use regular favicon
                        const activeTab = browserPayload.tabs?.find(t => t.id === browserPayload.activeTabId);
                        const faviconUrl = activeTab?.faviconUrl || null;
                        
                        if (faviconUrl) {
                          return (
                            <Favicon 
                              url={faviconUrl} 
                              fallback={<Globe className="h-4 w-4" />}
                            />
                          );
                        }
                      }
                      
                      // Use the icon mapping for all window types
                      const IconComponent = WINDOW_TYPE_ICONS[localWindow.type] || MonitorIcon;
                      return <IconComponent className="h-4 w-4 text-step-10 hover:text-birkin" />;
                    };
                    
                    const getPopoverContent = () => {
                      if (localWindow.type === 'classic-browser') {
                        const browserPayload = localWindow.payload as ClassicBrowserPayload;
                        if (browserPayload.tabs && browserPayload.tabs.length > 1) {
                          return (
                            <div className="flex flex-col">
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
                                      url={tab.faviconUrl || ''} 
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
                    };
                    
                    return (
                      <SidebarMenuItem key={localWindow.id}>
                        <HoverCard openDelay={200} closeDelay={100}>
                          <HoverCardTrigger asChild>
                            <SidebarMenuButton
                              onClick={async () => {
                                await activeStore?.getState().restoreWindow(localWindow.id);
                              }}
                              className="group-data-[collapsible=icon]:justify-center"
                            >
                              {renderIcon()}
                              <span className="truncate group-data-[collapsible=icon]:hidden">{localWindow.title}</span>
                            </SidebarMenuButton>
                          </HoverCardTrigger>
                          <HoverCardContent 
                            side="right" 
                            align="start" 
                            className="w-auto max-w-xl p-2 bg-step-3/80 backdrop-blur-lg text-step-11.5 dark:text-step-11 cursor-pointer hover:bg-step-3/80 hover:text-step-12 dark:hover:text-step-11.5"
                            onClick={async () => {
                              await activeStore?.getState().restoreWindow(localWindow.id);
                            }}
                          >
                            {getPopoverContent()}
                          </HoverCardContent>
                        </HoverCard>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}
        
      </SidebarContent>
    </Sidebar>
  );
} 