import { App, LogLevel, webApi } from '@slack/bolt';
type WebClient = webApi.WebClient;
import {
  type Result,
  ok,
  err,
  createError,
  ErrorCodes,
} from '../domain/services/result.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('SlackBoltClient');

export interface SlackConfig {
  appToken: string;
  botToken: string;
  signingSecret?: string;
}

export interface SendMessageParams {
  channel: string;
  text: string;
  threadTs?: string;
}

export interface UploadFileParams {
  /** Channel to share the file to (optional - file can be uploaded without sharing) */
  channel?: string;
  /** Thread timestamp to share the file in (optional) */
  threadTs?: string;
  /** File content as Buffer */
  content: Buffer;
  /** Filename with extension (e.g., "report.pdf") */
  filename: string;
  /** Optional title for the file */
  title?: string;
  /** Optional initial comment to accompany the file */
  initialComment?: string;
}

export interface UploadFileResult {
  /** Slack file ID */
  fileId: string;
  /** Permalink URL to the file */
  permalink: string;
}

export interface SlackMessage {
  ts: string;
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
}

/**
 * Wrapper around Slack Bolt SDK for Socket Mode
 */
export class SlackBoltClient {
  private app: App | null = null;
  private config: SlackConfig;

  constructor(config: SlackConfig) {
    this.config = config;
  }

  /**
   * Initialize the Slack app (call before start)
   */
  async initialize(): Promise<Result<void>> {
    try {
      this.app = new App({
        token: this.config.botToken,
        signingSecret: this.config.signingSecret,
        socketMode: true,
        appToken: this.config.appToken,
        logLevel: LogLevel.INFO,
      });

      logger.info('Slack app initialized');
      return ok(undefined);
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Slack app');
      return err(
        createError(
          ErrorCodes.SLACK_CONNECTION_FAILED,
          'Failed to initialize Slack app',
          error
        )
      );
    }
  }

  /**
   * Get the underlying Bolt App (for event registration)
   */
  getApp(): App {
    if (!this.app) {
      throw new Error('SlackBoltClient not initialized. Call initialize() first.');
    }
    return this.app;
  }

  /**
   * Get the underlying Slack WebClient.
   * Needed for advanced APIs not wrapped by this client (e.g. chatStream).
   */
  getWebClient(): WebClient {
    if (!this.app) {
      throw new Error('SlackBoltClient not initialized. Call initialize() first.');
    }
    return this.app.client;
  }

  /**
   * Start the Socket Mode connection
   */
  async start(): Promise<Result<void>> {
    if (!this.app) {
      return err(
        createError(
          ErrorCodes.INVALID_CONFIG,
          'SlackBoltClient not initialized. Call initialize() first.'
        )
      );
    }

    try {
      await this.app.start();
      logger.info('Slack Socket Mode connection started');
      return ok(undefined);
    } catch (error) {
      logger.error({ error }, 'Failed to start Slack connection');
      return err(
        createError(
          ErrorCodes.SLACK_CONNECTION_FAILED,
          'Failed to start Slack connection',
          error
        )
      );
    }
  }

  /**
   * Stop the Socket Mode connection
   */
  async stop(): Promise<Result<void>> {
    if (!this.app) {
      return ok(undefined);
    }

    try {
      await this.app.stop();
      logger.info('Slack Socket Mode connection stopped');
      return ok(undefined);
    } catch (error) {
      logger.error({ error }, 'Failed to stop Slack connection');
      return err(
        createError(
          ErrorCodes.SLACK_CONNECTION_FAILED,
          'Failed to stop Slack connection',
          error
        )
      );
    }
  }

  /**
   * Send a message to a channel or thread
   */
  async sendMessage(params: SendMessageParams): Promise<Result<string>> {
    if (!this.app) {
      return err(
        createError(
          ErrorCodes.INVALID_CONFIG,
          'SlackBoltClient not initialized'
        )
      );
    }

    try {
      const result = await this.app.client.chat.postMessage({
        channel: params.channel,
        text: params.text,
        thread_ts: params.threadTs,
      });

      if (!result.ok || !result.ts) {
        return err(
          createError(
            ErrorCodes.SLACK_SEND_FAILED,
            `Failed to send message: ${result.error ?? 'unknown error'}`
          )
        );
      }

      logger.debug(
        { channel: params.channel, ts: result.ts },
        'Message sent successfully'
      );

      return ok(result.ts);
    } catch (error) {
      logger.error({ error, params }, 'Failed to send message');
      return err(
        createError(ErrorCodes.SLACK_SEND_FAILED, 'Failed to send message', error)
      );
    }
  }

  /**
   * Test the connection by fetching auth info
   */
  async testConnection(): Promise<
    Result<{ teamName: string; teamId: string; botName: string; botUserId: string }>
  > {
    if (!this.app) {
      return err(
        createError(
          ErrorCodes.INVALID_CONFIG,
          'SlackBoltClient not initialized'
        )
      );
    }

    try {
      const authResult = await this.app.client.auth.test();

      if (!authResult.ok) {
        return err(
          createError(
            ErrorCodes.SLACK_CONNECTION_FAILED,
            `Auth test failed: ${authResult.error ?? 'unknown error'}`
          )
        );
      }

      return ok({
        teamName: authResult.team ?? 'Unknown',
        teamId: authResult.team_id ?? '',
        botName: authResult.user ?? 'Unknown',
        botUserId: authResult.user_id ?? 'Unknown',
      });
    } catch (error) {
      logger.error({ error }, 'Auth test failed');
      return err(
        createError(
          ErrorCodes.SLACK_CONNECTION_FAILED,
          'Auth test failed',
          error
        )
      );
    }
  }

  /**
   * Update an existing message
   */
  async updateMessage(params: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<Result<void>> {
    if (!this.app) {
      return err(
        createError(
          ErrorCodes.INVALID_CONFIG,
          'SlackBoltClient not initialized'
        )
      );
    }

    try {
      const result = await this.app.client.chat.update({
        channel: params.channel,
        ts: params.ts,
        text: params.text,
      });

      if (!result.ok) {
        return err(
          createError(
            ErrorCodes.SLACK_SEND_FAILED,
            `Failed to update message: ${result.error ?? 'unknown error'}`
          )
        );
      }

      logger.debug(
        { channel: params.channel, ts: params.ts },
        'Message updated successfully'
      );

      return ok(undefined);
    } catch (error) {
      logger.error({ error, params }, 'Failed to update message');
      return err(
        createError(ErrorCodes.SLACK_SEND_FAILED, 'Failed to update message', error)
      );
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(params: {
    channel: string;
    ts: string;
  }): Promise<Result<void>> {
    if (!this.app) {
      return err(
        createError(
          ErrorCodes.INVALID_CONFIG,
          'SlackBoltClient not initialized'
        )
      );
    }

    try {
      const result = await this.app.client.chat.delete({
        channel: params.channel,
        ts: params.ts,
      });

      if (!result.ok) {
        return err(
          createError(
            ErrorCodes.SLACK_SEND_FAILED,
            `Failed to delete message: ${result.error ?? 'unknown error'}`
          )
        );
      }

      logger.debug(
        { channel: params.channel, ts: params.ts },
        'Message deleted successfully'
      );

      return ok(undefined);
    } catch (error) {
      logger.error({ error, params }, 'Failed to delete message');
      return err(
        createError(ErrorCodes.SLACK_SEND_FAILED, 'Failed to delete message', error)
      );
    }
  }

  /**
   * Upload a file to Slack
   *
   * Uses the files.uploadV2 API which supports larger files and
   * returns complete file metadata.
   *
   * Note: Requires `files:write` scope on the bot token.
   */
  async uploadFile(params: UploadFileParams): Promise<Result<UploadFileResult>> {
    if (!this.app) {
      return err(
        createError(
          ErrorCodes.INVALID_CONFIG,
          'SlackBoltClient not initialized'
        )
      );
    }

    // If thread_ts is provided, channel must also be provided
    if (params.threadTs && !params.channel) {
      return err(
        createError(
          ErrorCodes.INVALID_CONFIG,
          'channel is required when threadTs is provided'
        )
      );
    }

    try {
      // Build the upload request
      // We use type assertion because Slack's types have complex discriminated unions
      // for channel_id/thread_ts that are hard to satisfy dynamically
      const uploadRequest = {
        file: params.content,
        filename: params.filename,
        ...(params.title && { title: params.title }),
        ...(params.initialComment && { initial_comment: params.initialComment }),
        ...(params.channel && { channel_id: params.channel }),
        ...(params.threadTs && { thread_ts: params.threadTs }),
      } as Parameters<typeof this.app.client.files.uploadV2>[0];

      const result = await this.app.client.files.uploadV2(uploadRequest);

      if (!result.ok) {
        return err(
          createError(
            ErrorCodes.SLACK_UPLOAD_FAILED,
            `Failed to upload file: ${result.error ?? 'unknown error'}`
          )
        );
      }

      // files.uploadV2 returns a nested structure:
      // result.files[0].files[0] contains the actual file info
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultAny = result as any;
      const uploadResult = resultAny.files?.[0];
      const fileInfo = uploadResult?.files?.[0];

      if (!fileInfo?.id) {
        logger.error(
          { resultKeys: Object.keys(result), uploadResult },
          'Unexpected response structure'
        );
        return err(
          createError(
            ErrorCodes.SLACK_UPLOAD_FAILED,
            'Upload succeeded but no file ID returned'
          )
        );
      }

      logger.debug(
        {
          fileId: fileInfo.id,
          filename: params.filename,
          channel: params.channel,
        },
        'File uploaded successfully'
      );

      return ok({
        fileId: fileInfo.id,
        permalink: fileInfo.permalink ?? '',
      });
    } catch (error) {
      logger.error({ error, filename: params.filename }, 'Failed to upload file');
      return err(
        createError(ErrorCodes.SLACK_UPLOAD_FAILED, 'Failed to upload file', error)
      );
    }
  }
}

/**
 * Create SlackBoltClient from environment variables
 */
export function createSlackClientFromEnv(): Result<SlackBoltClient> {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!appToken) {
    return err(
      createError(
        ErrorCodes.INVALID_CONFIG,
        'SLACK_APP_TOKEN environment variable is required'
      )
    );
  }

  if (!botToken) {
    return err(
      createError(
        ErrorCodes.INVALID_CONFIG,
        'SLACK_BOT_TOKEN environment variable is required'
      )
    );
  }

  return ok(
    new SlackBoltClient({
      appToken,
      botToken,
      signingSecret,
    })
  );
}
