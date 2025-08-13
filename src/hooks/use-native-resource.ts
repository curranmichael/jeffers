import { useRef, useEffect } from 'react';

/**
 * Hook for managing native resource lifecycle
 * 
 * This hook handles the creation and destruction of native resources (like BrowserViews)
 * in sync with React component lifecycle.
 * 
 * @param onMount - Callback to create/initialize the native resource
 * @param onUnmount - Callback to destroy/cleanup the native resource
 * @param dependencies - Dependencies array that will trigger recreation when changed
 * @param options - Optional configuration
 */
export function useNativeResource<T = void>(
  onMount: () => T | Promise<T>,
  onUnmount: (resource?: T) => void | Promise<void>,
  dependencies: React.DependencyList,
  options?: {
    /** Whether to log lifecycle events for debugging */
    debug?: boolean;
    /** Debug label for logging */
    debugLabel?: string;
  }
) {
  const resourceRef = useRef<T | undefined>(undefined);
  const isMountedRef = useRef(false);
  
  const { debug = false, debugLabel = 'NativeResource' } = options || {};

  useEffect(() => {
    // Mark as mounted
    isMountedRef.current = true;

    // Execute mount callback
    const mountResource = async () => {
      try {
        if (debug) console.log(`[${debugLabel}] Mounting resource`);
        const resource = await onMount();
        resourceRef.current = resource;
        if (debug) console.log(`[${debugLabel}] Resource mounted successfully`, resource);
      } catch (error) {
        console.error(`[${debugLabel}] Error mounting resource:`, error);
      }
    };

    mountResource();

    // Cleanup function - execute immediately on unmount
    return () => {
      if (debug) console.log(`[${debugLabel}] Cleanup triggered, executing immediate unmount`);
      
      // Mark as unmounted
      isMountedRef.current = false;
      
      // Execute cleanup immediately
      const executeCleanup = async () => {
        if (debug) console.log(`[${debugLabel}] Executing unmount`);
        try {
          await onUnmount(resourceRef.current);
          resourceRef.current = undefined;
          if (debug) console.log(`[${debugLabel}] Resource unmounted successfully`);
        } catch (error) {
          console.error(`[${debugLabel}] Error unmounting resource:`, error);
        }
      };
      
      executeCleanup();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  return {
    /** Whether the resource is currently mounted */
    isMounted: isMountedRef.current,
    /** Reference to the resource (if any was returned by onMount) */
    resource: resourceRef.current,
  };
}

