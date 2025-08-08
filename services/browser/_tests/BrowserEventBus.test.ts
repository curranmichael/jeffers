import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrowserEventBus } from '../BrowserEventBus';
import type { BrowserEvent } from '../types';

describe('BrowserEventBus', () => {
  let eventBus: BrowserEventBus;

  beforeEach(() => {
    eventBus = new BrowserEventBus();
  });

  describe('event emission and subscription', () => {
    it('should emit and receive events', () => {
      const listener = vi.fn();
      eventBus.on('navigation:complete', listener);
      
      const eventData: BrowserEvent['navigation:complete'] = {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      };
      
      eventBus.emit('navigation:complete', eventData);
      
      expect(listener).toHaveBeenCalledWith(eventData);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should not receive events after unsubscribing', () => {
      const listener = vi.fn();
      eventBus.on('navigation:complete', listener);
      
      eventBus.off('navigation:complete', listener);
      
      eventBus.emit('navigation:complete', {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      });
      
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('type safety enforcement', () => {
    it('should enforce correct event data types', () => {
      const listener = vi.fn<[BrowserEvent['tab:created']], void>();
      eventBus.on('tab:created', listener);
      
      const correctData: BrowserEvent['tab:created'] = {
        tabId: 'tab-1',
        url: 'https://example.com',
        index: 0
      };
      
      eventBus.emit('tab:created', correctData);
      
      expect(listener).toHaveBeenCalledWith(correctData);
    });

    it('should handle different event types independently', () => {
      const navListener = vi.fn<[BrowserEvent['navigation:complete']], void>();
      const tabListener = vi.fn<[BrowserEvent['tab:created']], void>();
      
      eventBus.on('navigation:complete', navListener);
      eventBus.on('tab:created', tabListener);
      
      eventBus.emit('navigation:complete', {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      });
      
      expect(navListener).toHaveBeenCalledTimes(1);
      expect(tabListener).not.toHaveBeenCalled();
    });
  });

  describe('memory cleanup', () => {
    it('should remove all listeners with removeAllListeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();
      
      eventBus.on('navigation:complete', listener1);
      eventBus.on('tab:created', listener2);
      eventBus.on('tab:closed', listener3);
      
      eventBus.removeAllListeners();
      
      eventBus.emit('navigation:complete', {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      });
      eventBus.emit('tab:created', {
        tabId: 'tab-1',
        url: 'https://example.com',
        index: 0
      });
      eventBus.emit('tab:closed', { tabId: 'tab-1' });
      
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(listener3).not.toHaveBeenCalled();
    });

    it('should remove all listeners for a specific event', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();
      
      eventBus.on('navigation:complete', listener1);
      eventBus.on('navigation:complete', listener2);
      eventBus.on('tab:created', listener3);
      
      eventBus.removeAllListeners('navigation:complete');
      
      eventBus.emit('navigation:complete', {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      });
      eventBus.emit('tab:created', {
        tabId: 'tab-1',
        url: 'https://example.com',
        index: 0
      });
      
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(listener3).toHaveBeenCalledTimes(1);
    });
  });

  describe('multiple listeners per event', () => {
    it('should support multiple listeners for the same event', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();
      
      eventBus.on('navigation:complete', listener1);
      eventBus.on('navigation:complete', listener2);
      eventBus.on('navigation:complete', listener3);
      
      const eventData: BrowserEvent['navigation:complete'] = {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      };
      
      eventBus.emit('navigation:complete', eventData);
      
      expect(listener1).toHaveBeenCalledWith(eventData);
      expect(listener2).toHaveBeenCalledWith(eventData);
      expect(listener3).toHaveBeenCalledWith(eventData);
    });

    it('should call listeners in registration order', () => {
      const callOrder: number[] = [];
      const listener1 = vi.fn(() => callOrder.push(1));
      const listener2 = vi.fn(() => callOrder.push(2));
      const listener3 = vi.fn(() => callOrder.push(3));
      
      eventBus.on('navigation:complete', listener1);
      eventBus.on('navigation:complete', listener2);
      eventBus.on('navigation:complete', listener3);
      
      eventBus.emit('navigation:complete', {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      });
      
      expect(callOrder).toEqual([1, 2, 3]);
    });

    it('should allow removing specific listeners without affecting others', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();
      
      eventBus.on('navigation:complete', listener1);
      eventBus.on('navigation:complete', listener2);
      eventBus.on('navigation:complete', listener3);
      
      eventBus.off('navigation:complete', listener2);
      
      eventBus.emit('navigation:complete', {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      });
      
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).not.toHaveBeenCalled();
      expect(listener3).toHaveBeenCalledTimes(1);
    });
  });

  describe('once vs on behavior', () => {
    it('should call once listeners only one time', () => {
      const listener = vi.fn();
      eventBus.once('navigation:complete', listener);
      
      const eventData: BrowserEvent['navigation:complete'] = {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      };
      
      eventBus.emit('navigation:complete', eventData);
      eventBus.emit('navigation:complete', eventData);
      eventBus.emit('navigation:complete', eventData);
      
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(eventData);
    });

    it('should call on listeners multiple times', () => {
      const listener = vi.fn();
      eventBus.on('navigation:complete', listener);
      
      const eventData: BrowserEvent['navigation:complete'] = {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      };
      
      eventBus.emit('navigation:complete', eventData);
      eventBus.emit('navigation:complete', eventData);
      eventBus.emit('navigation:complete', eventData);
      
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it('should support mixing once and on listeners', () => {
      const onceListener = vi.fn();
      const onListener = vi.fn();
      
      eventBus.once('navigation:complete', onceListener);
      eventBus.on('navigation:complete', onListener);
      
      const eventData: BrowserEvent['navigation:complete'] = {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      };
      
      eventBus.emit('navigation:complete', eventData);
      eventBus.emit('navigation:complete', eventData);
      
      expect(onceListener).toHaveBeenCalledTimes(1);
      expect(onListener).toHaveBeenCalledTimes(2);
    });

    it('should properly remove once listeners after execution', () => {
      const onceListener = vi.fn();
      const onListener = vi.fn();
      
      eventBus.once('navigation:complete', onceListener);
      eventBus.on('navigation:complete', onListener);
      
      eventBus.emit('navigation:complete', {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      });
      
      eventBus.removeAllListeners('navigation:complete');
      
      eventBus.emit('navigation:complete', {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      });
      
      expect(onceListener).toHaveBeenCalledTimes(1);
      expect(onListener).toHaveBeenCalledTimes(1);
    });

    it('should handle once listener removal before execution', () => {
      const listener = vi.fn();
      eventBus.once('navigation:complete', listener);
      
      eventBus.off('navigation:complete', listener);
      
      eventBus.emit('navigation:complete', {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      });
      
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle emitting events with no listeners', () => {
      expect(() => {
        eventBus.emit('navigation:complete', {
          tabId: 'tab-1',
          url: 'https://example.com',
          title: 'Example'
        });
      }).not.toThrow();
    });

    it('should handle removing non-existent listeners', () => {
      const listener = vi.fn();
      
      expect(() => {
        eventBus.off('navigation:complete', listener);
      }).not.toThrow();
    });

    it('should handle listener errors without stopping other listeners', () => {
      const errorListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const successListener = vi.fn();
      
      eventBus.on('navigation:complete', errorListener);
      eventBus.on('navigation:complete', successListener);
      
      const eventData: BrowserEvent['navigation:complete'] = {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example'
      };
      
      expect(() => {
        eventBus.emit('navigation:complete', eventData);
      }).not.toThrow();
      
      expect(errorListener).toHaveBeenCalled();
      expect(successListener).toHaveBeenCalledWith(eventData);
    });
  });
});