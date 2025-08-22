"use client";

import React, { useState, useCallback } from 'react';
import { IntentLine } from '@/components/ui/intent-line';
import { isLikelyUrl, formatUrlWithProtocol } from './urlDetection.helpers';
import { cn } from '@/lib/utils';

interface NavObjectProps {
  onNavigate: (url: string) => void;
  isFocused?: boolean;
}

export function NavObject({ onNavigate, isFocused = true }: NavObjectProps) {
  const [intent, setIntent] = useState('');

  const handleSubmit = useCallback((value: string) => {
    const trimmedValue = value.trim();
    if (!trimmedValue) return;

    // Check if it looks like a URL
    if (isLikelyUrl(trimmedValue)) {
      // It's a URL - format it with protocol if needed
      const formattedUrl = formatUrlWithProtocol(trimmedValue);
      onNavigate(formattedUrl);
    } else {
      // It's a search query - use Perplexity search
      const encodedQuery = encodeURIComponent(trimmedValue);
      const searchUrl = `https://www.perplexity.ai/search?q=${encodedQuery}`;
      onNavigate(searchUrl);
    }
    
    // Clear the intent after submitting
    setIntent('');
  }, [onNavigate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(intent);
    }
  }, [intent, handleSubmit]);

  return (
    <div className={cn(
      "flex flex-col items-center justify-center h-full w-full",
      isFocused ? 'bg-step-1' : 'bg-step-2'
    )}>
      <div className="max-w-2xl w-full px-8">
        {/* Intent Line */}
        <div className="w-full mb-8">
          <IntentLine
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search or enter URL..."
            className="w-full text-base text-step-12 bg-transparent border-0 border-b-[1px] border-step-9 hover:border-step-11.5 focus:ring-0 focus:border-step-10 placeholder:text-step-12"
            autoFocus
          />
        </div>
        
        {/* Quick Links (optional - for future enhancement) */}
        <div className="mt-12 flex flex-wrap justify-center gap-4">
          {/* We could add bookmarks, recent sites, etc. here later */}
        </div>
      </div>
    </div>
  );
}