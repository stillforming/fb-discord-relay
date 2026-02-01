import { config } from '../config.js';
import { generateAppSecretProof } from '../utils/signature.js';
import { logger } from '../logger.js';

const log = logger.child({ service: 'facebook' });

export interface FacebookPost {
  id: string;
  message?: string;
  permalink_url?: string;
  created_time?: string;
  from?: {
    id: string;
    name: string;
  };
  attachments?: {
    data: Array<{
      media_type?: string;
      url?: string;
      media?: {
        image?: {
          src: string;
        };
      };
    }>;
  };
}

export interface FetchPostResult {
  success: boolean;
  post?: FacebookPost;
  error?: string;
  retryable?: boolean;
}

/**
 * Fetch a post from the Facebook Graph API
 */
export async function fetchPost(postId: string): Promise<FetchPostResult> {
  const fields = 'id,message,permalink_url,created_time,from,attachments{media_type,url,media}';
  const appSecretProof = generateAppSecretProof(config.META_PAGE_ACCESS_TOKEN);

  const url = new URL(`https://graph.facebook.com/${config.META_GRAPH_VERSION}/${postId}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', config.META_PAGE_ACCESS_TOKEN);
  url.searchParams.set('appsecret_proof', appSecretProof);

  log.debug({ postId, url: url.toString().replace(/access_token=[^&]+/, 'access_token=***') }, 'Fetching post from Graph API');

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    const data = await response.json() as FacebookPost & { error?: { code?: number; message?: string } };

    if (!response.ok) {
      const error = data.error;
      log.warn({ postId, error }, 'Graph API error');

      // Check if retryable
      // Common codes: 1 = unknown, 2 = temporary, 4 = rate limit, 17 = rate limit
      const retryableCodes = [1, 2, 4, 17];
      const isRetryable = error?.code && retryableCodes.includes(error.code);

      return {
        success: false,
        error: error?.message || `HTTP ${response.status}`,
        retryable: isRetryable || response.status >= 500,
      };
    }

    // Validate the post is from our page
    if (data.from?.id !== config.META_PAGE_ID) {
      log.warn({ postId, authorId: data.from?.id, pageId: config.META_PAGE_ID }, 'Post not from configured page');
      return {
        success: false,
        error: 'Post not from configured page',
        retryable: false,
      };
    }

    log.info({ postId, hasMessage: !!data.message }, 'Successfully fetched post');

    return {
      success: true,
      post: data as FacebookPost,
    };
  } catch (err) {
    log.error({ postId, error: err }, 'Network error fetching post');
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown network error',
      retryable: true,
    };
  }
}

/**
 * Verify the page access token is valid and has required permissions
 */
export async function verifyPageAccess(): Promise<boolean> {
  const url = new URL(`https://graph.facebook.com/${config.META_GRAPH_VERSION}/${config.META_PAGE_ID}`);
  url.searchParams.set('fields', 'id,name');
  url.searchParams.set('access_token', config.META_PAGE_ACCESS_TOKEN);

  try {
    const response = await fetch(url.toString());
    const data = await response.json() as { id?: string; name?: string; error?: unknown };

    if (!response.ok) {
      log.error({ error: data.error }, 'Failed to verify page access');
      return false;
    }

    log.info({ pageId: data.id, pageName: data.name }, 'Page access verified');
    return true;
  } catch (err) {
    log.error({ error: err }, 'Network error verifying page access');
    return false;
  }
}
