import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { CompletionService } from './types';
import { CompletionServiceErr } from './types';

export function createOpenRouterCompletionService(): CompletionService {
  return {
    async complete({ apiKey, model, systemPrompt, userPrompt }) {
      if (!apiKey) {
        return CompletionServiceErr({
          message: 'OpenRouter API key is required.',
          context: { status: 401, name: 'MissingApiKey' },
          cause: null,
        });
      }
      if (!model) {
        return CompletionServiceErr({
          message: 'Model name is required for OpenRouter completion.',
          context: { status: 400, name: 'MissingModel' },
          cause: null,
        });
      }
      const { data, error } = await tryAsync({
        try: async () => {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
            }),
          });
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw {
              status: response.status,
              name: 'OpenRouterAPIError',
              message: err?.error?.message || err?.message || response.statusText,
              error: err,
            };
          }
          const result = await response.json();
          return result.choices?.[0]?.message?.content || '';
        },
        mapErr: (error) => {
          let errMsg = 'OpenRouter completion failed.';
          let status = undefined;
          let name = undefined;
          if (typeof error === 'object' && error !== null) {
            // @ts-ignore
            errMsg = error.message || errMsg;
            // @ts-ignore
            status = error.status;
            // @ts-ignore
            const errObj = error as { message?: string; status?: number; name?: string };
            errMsg = errObj.message || errMsg;
            status = errObj.status;
            name = errObj.name;
          }
          return CompletionServiceErr({
            message: errMsg,
            context: { status, name },
            cause: error,
          });
        },
      });
      if (error) return Err(error);
      return Ok(data);
    },
  };
}

export type OpenRouterCompletionService = ReturnType<
  typeof createOpenRouterCompletionService
>;

export const OpenRouterCompletionServiceLive = createOpenRouterCompletionService();