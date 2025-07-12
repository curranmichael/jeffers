"use client";

import { useAppNavigationStore } from '@/store/appNavigationStore';
import HomeView from '@/components/HomeView';
import NotebookView from '@/components/NotebookView';

export default function HomePage() {
  const { currentNotebookId, _hasHydrated } = useAppNavigationStore();

  // Show loading state while store hydrates
  if (!_hasHydrated) {
    return <div className="h-screen bg-step-1" />;
  }

  // Conditionally render based on navigation state
  return currentNotebookId 
    ? <NotebookView notebookId={currentNotebookId} />
    : <HomeView />;
}