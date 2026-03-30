/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import { type UIState } from '../ui/contexts/UIStateContext.js';
import { StreamingState } from '../ui/types.js';
import { debugLogger } from '@google/gemini-cli-core';

interface InputBody {
  input: string;
}

function isInputBody(obj: unknown): obj is InputBody {
  if (!obj || typeof obj !== 'object') return false;
  return (
    'input' in obj && typeof (obj as { input?: unknown }).input === 'string'
  );
}

/**
 * RemoteControlService exposes a RESTful HTTP server to monitor and control the CLI.
 *
 * It allows external tools to:
 * 1. Get the current status of the CLI (Busy, Waiting for input, etc.).
 * 2. Capture the current screen content (ANSI format).
 * 3. Inject user input into the CLI.
 */
export class RemoteControlService {
  private static instance: RemoteControlService | undefined;
  private server: http.Server | null = null;
  private currentUIState: UIState | null = null;
  private inkLastFrame: (() => string | undefined) | null = null;

  private constructor() {}

  static getInstance(): RemoteControlService {
    if (!RemoteControlService.instance) {
      RemoteControlService.instance = new RemoteControlService();
    }
    return RemoteControlService.instance;
  }

  /**
   * Updates the current UI state.
   * Required for status reporting.
   */
  updateUIState(state: UIState) {
    this.currentUIState = state;
  }

  /**
   * Registers the Ink instance's lastFrame function for screen capture.
   */
  setLastFrameFn(fn: () => string | undefined) {
    this.inkLastFrame = fn;
  }

  /**
   * Derives a human-readable status from the current UI state.
   */
  private getStatus(): string {
    if (!this.currentUIState) return 'Initializing';

    const {
      streamingState,
      isInputActive,
      commandConfirmationRequest,
      loopDetectionConfirmationRequest,
      permissionConfirmationRequest,
      authError,
      initError,
      isAuthenticating,
      isRestarting,
    } = this.currentUIState;

    if (authError || initError) return 'Error';
    if (isRestarting) return 'Restarting';
    if (isAuthenticating) return 'Authenticating';
    if (streamingState === StreamingState.Responding) return 'Busy';
    if (
      commandConfirmationRequest ||
      loopDetectionConfirmationRequest ||
      permissionConfirmationRequest
    ) {
      return 'Waiting for confirmation';
    }
    if (isInputActive) return 'Waiting for input';

    return 'Idle';
  }

  /**
   * Starts the HTTP server on the specified port.
   */
  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        resolve();
        return;
      }

      this.server = http.createServer((req, res) => {
        // Set CORS headers for local access
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === 'GET' && req.url === '/status') {
          const status = {
            status: this.getStatus(),
            streamingState: this.currentUIState?.streamingState,
            isInputActive: this.currentUIState?.isInputActive,
            isWaitingForConfirmation: !!(
              this.currentUIState?.commandConfirmationRequest ||
              this.currentUIState?.loopDetectionConfirmationRequest ||
              this.currentUIState?.permissionConfirmationRequest
            ),
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(status, null, 2));
        } else if (
          req.method === 'GET' &&
          req.url &&
          req.url.startsWith('/history')
        ) {
          const urlObj = new URL(
            req.url,
            `http://${req.headers.host || 'localhost'}`,
          );
          const linesParam = urlObj.searchParams.get('lines');
          const history = this.currentUIState?.history || [];

          let responseHistory = history;
          if (linesParam && linesParam.toUpperCase() !== 'ALL') {
            const numLines = parseInt(linesParam, 10);
            if (!isNaN(numLines) && numLines > 0) {
              responseHistory = history.slice(-numLines);
            }
          } else if (!linesParam) {
            // Default to 100 lines if not specified
            responseHistory = history.slice(-100);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseHistory, null, 2));
        } else if (req.method === 'GET' && req.url === '/screen') {
          const frame = this.inkLastFrame?.() ?? '';
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(frame);
        } else if (req.method === 'POST' && req.url === '/input') {
          let body = '';
          req.on('data', (chunk: string) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const data = JSON.parse(body) as unknown;
              if (isInputBody(data)) {
                // Normalize \n → \r (raw terminal Enter signal), then split
                // so text and \r are emitted in separate event-loop ticks.
                // This avoids bufferFastReturn() converting an immediately
                // following \r into shift+enter (which does not submit).
                const normalized = data.input.replace(/\n/g, '\r');
                const parts = normalized.split('\r');
                let delay = 0;
                for (let i = 0; i < parts.length; i++) {
                  if (parts[i]) {
                    const text = parts[i];
                    setTimeout(() => process.stdin.emit('data', text), delay);
                    delay += 50; // > FAST_RETURN_TIMEOUT (30 ms)
                  }
                  if (i < parts.length - 1) {
                    setTimeout(() => process.stdin.emit('data', '\r'), delay);
                    delay += 50;
                  }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return;
              }
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ error: 'Invalid input: expected string' }),
              );
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
          });
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.server.on('error', (err: unknown) => {
        if (
          err instanceof Error &&
          'code' in err &&
          err.code === 'EADDRINUSE'
        ) {
          debugLogger.error(`RemoteControl: Port ${port} already in use.`);
          reject(new Error(`Port ${port} is already in use`));
        } else {
          debugLogger.error('RemoteControl: Server error:', err);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      this.server.listen(port, '127.0.0.1', () => {
        debugLogger.log(
          `RemoteControl: Server started on http://127.0.0.1:${port}`,
        );
        resolve();
      });
    });
  }

  /**
   * Stops the HTTP server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          debugLogger.log('RemoteControl: Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
