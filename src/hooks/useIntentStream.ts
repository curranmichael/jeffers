"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { DisplaySlice } from '@/../shared/types/search.types';
import type { IntentResultPayload, SetIntentPayload } from '@/../shared/types/intent.types';

// Simple frontend performance tracking (matching useChatStream pattern)
const logTiming = (correlationId: string, event: string, metadata?: unknown) => {
  const timestamp = performance.now();
  console.log(`[Performance] ${correlationId} - Frontend:${event} at ${timestamp.toFixed(2)}ms`, metadata);
};

interface UseIntentStreamOptions {
  debugId?: string; // For distinct logging per instance
}

interface UseIntentStreamReturn {
  response: string;
  slices: DisplaySlice[];
  isLoading: boolean;
  error: string | null;
  startStream: (intent: string) => void;
  stopStream: () => void;
}

export function useIntentStream({
  debugId = 'IntentStream',
}: UseIntentStreamOptions = {}): UseIntentStreamReturn {
  // Stabilize debugId to prevent log function recreation
  const stableDebugId = useRef(debugId);
  useEffect(() => {
    stableDebugId.current = debugId;
  }, [debugId]);
  const [response, setResponse] = useState('');
  const [slices, setSlices] = useState<DisplaySlice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  
  // Performance tracking refs
  const streamStartTimeRef = useRef<number>(0);
  const currentCorrelationIdRef = useRef<string>('');
  const firstChunkReceivedRef = useRef<boolean>(false);

  const log = useCallback((level: 'log' | 'warn' | 'error', ...args: unknown[]) => {
    const prefix = `[${stableDebugId.current}]`;
    if (process.env.NODE_ENV === 'development') {
      console[level](prefix, ...args);
    }
  }, []); // No dependencies - function is now stable

  // Effect for handling IPC listeners for intent streaming
  useEffect(() => {
    log('log', 'Setting up IPC listeners for intent stream.');

    // Handle initial search results/slices
    const handleResult = (result: IntentResultPayload) => {
      log('log', 'Received intent result:', result);
      
      // Store slices if this is a chat_reply with slices
      if (result.type === 'chat_reply' && result.slices && result.slices.length > 0) {
        setSlices(result.slices);
        log('log', `Stored ${result.slices.length} search slices`);
      }
    };

    const handleStreamStart = (data: { streamId: string }) => {
      log('log', `Stream started: ${data.streamId}`);
      
      // Track stream start timing
      if (currentCorrelationIdRef.current) {
        const elapsed = performance.now() - streamStartTimeRef.current;
        logTiming(currentCorrelationIdRef.current, 'stream_start', { 
          elapsed: `${elapsed.toFixed(2)}ms`,
          streamId: data.streamId 
        });
      }
      
      setStreamingContent('');
      firstChunkReceivedRef.current = false;
    };

    const handleChunk = (data: { streamId: string; chunk: string }) => {
      // Track first chunk timing
      if (!firstChunkReceivedRef.current && currentCorrelationIdRef.current) {
        firstChunkReceivedRef.current = true;
        const elapsed = performance.now() - streamStartTimeRef.current;
        logTiming(currentCorrelationIdRef.current, 'first_chunk_received', { 
          elapsed: `${elapsed.toFixed(2)}ms`,
          chunkLength: data.chunk.length 
        });
      }
      
      // Append chunk to streaming content
      setStreamingContent(prev => {
        const newContent = prev + data.chunk;
        log('log', `Chunk received. Total length: ${newContent.length}`);
        return newContent;
      });
    };

    const handleEnd = (data: { streamId: string; messageId?: string }) => {
      log('log', `Stream ended: ${data.streamId}`);
      
      // Track stream completion timing
      if (currentCorrelationIdRef.current) {
        const elapsed = performance.now() - streamStartTimeRef.current;
        logTiming(currentCorrelationIdRef.current, 'stream_complete', { 
          elapsed: `${elapsed.toFixed(2)}ms`,
          streamId: data.streamId,
          messageId: data.messageId
        });
      }
      
      // Use callback to get current streaming content
      setStreamingContent(currentStreaming => {
        // Set the final response
        setResponse(currentStreaming);
        // Clear streaming content
        return '';
      });
      
      setIsLoading(false);
    };

    const handleError = (data: { streamId?: string; error: string }) => {
      log('error', 'Stream error:', data.error);
      
      setError(`Stream error: ${data.error}`);
      setIsLoading(false);
      setStreamingContent('');
    };

    const removeResultListener = window.api.onIntentResult(handleResult);
    const removeStreamStartListener = window.api.onIntentStreamStart(handleStreamStart);
    const removeChunkListener = window.api.onIntentStreamChunk(handleChunk);
    const removeEndListener = window.api.onIntentStreamEnd(handleEnd);
    const removeErrorListener = window.api.onIntentStreamError(handleError);

    return () => {
      log('log', 'Removing IPC listeners for intent stream.');
      removeResultListener();
      removeStreamStartListener();
      removeChunkListener();
      removeEndListener();
      removeErrorListener();
      
      // Note: Intent API doesn't have a stopIntentStream method like chat does
      // If the hook is cleaning up while a stream is active, we can't stop it from client side
    };
  }, [log]);

  const startStream = useCallback((intent: string) => {
    if (!intent.trim() || isLoading) return;

    // Clear previous state
    setResponse('');
    setSlices([]);
    setIsLoading(true);
    setError(null);
    setStreamingContent('');

    // Generate a correlation ID for performance tracking
    const correlationId = `intent-${Date.now()}`;
    
    streamStartTimeRef.current = performance.now();
    firstChunkReceivedRef.current = false;
    currentCorrelationIdRef.current = correlationId;
    
    log('log', `Starting intent stream with correlationId: ${correlationId}`);
    logTiming(correlationId, 'intent_submitted', { intent: intent.substring(0, 50) });
    
    // Send the intent
    const payload: SetIntentPayload = {
      intentText: intent,
      context: 'welcome'
    };
    window.api.setIntent(payload);
  }, [isLoading, log]);

  const stopStream = useCallback(() => {
    // Note: Intent API doesn't provide a stop method
    // We can only stop tracking on the client side
    if (isLoading) {
      log('log', 'Stopping intent stream tracking (client-side only).');
      setIsLoading(false);
      setStreamingContent('');
      setError('Stream cancelled by user');
    }
  }, [isLoading, log]);

  // Return the current response (either final or streaming)
  const displayResponse = isLoading && streamingContent ? streamingContent : response;

  return useMemo(() => ({
    response: displayResponse,
    slices,
    isLoading,
    error,
    startStream,
    stopStream,
  }), [displayResponse, slices, isLoading, error, startStream, stopStream]);
}