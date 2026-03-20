import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export interface XTerminalProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  className?: string;
}

export interface XTerminalRef {
  write: (data: string) => void;
  focus: () => void;
  clear: () => void;
  fit: () => void;
}

export const XTerminal = forwardRef<XTerminalRef, XTerminalProps>(
  ({ onData, onResize, className = '' }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);

    const onDataRef = useRef(onData);
    const onResizeRef = useRef(onResize);
    useEffect(() => { onDataRef.current = onData; }, [onData]);
    useEffect(() => { onResizeRef.current = onResize; }, [onResize]);

    useImperativeHandle(ref, () => ({
      write: (data: string) => terminalRef.current?.write(data),
      focus: () => terminalRef.current?.focus(),
      clear: () => terminalRef.current?.clear(),
      fit: () => {
        try {
          fitAddonRef.current?.fit();
          if (terminalRef.current) {
            onResizeRef.current(terminalRef.current.cols, terminalRef.current.rows);
          }
        } catch { /* ignore */ }
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      const term = new Terminal({
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 14,
        theme: {
          background: '#1e1e1e', // Match existing UI
          foreground: '#d4d4d4',
          cursor: '#ffffff',
          selectionBackground: '#5c5c5c',
        },
        cursorBlink: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      term.open(containerRef.current);
      
      // Delay initial fit slightly to ensure DOM is ready
      setTimeout(() => {
        try {
          fitAddon.fit();
          onResize(term.cols, term.rows);
        } catch { /* ignore if unmounted */ }
      }, 50);

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;

      // Handle input
      const dataDisposable = term.onData((data) => {
        onData(data);
      });

      // Handle Resize Window
      const handleResize = () => {
        try {
          fitAddon.fit();
          onResize(term.cols, term.rows);
        } catch {}
      };

      window.addEventListener('resize', handleResize);

      return () => {
        window.removeEventListener('resize', handleResize);
        dataDisposable.dispose();
        term.dispose();
      };
    }, []); // Empty deps to run once

    return (
      <div 
        ref={containerRef} 
        className={`w-full h-full overflow-hidden ${className}`}
        style={{ minHeight: '300px' }}
      />
    );
  }
);

XTerminal.displayName = 'XTerminal';
