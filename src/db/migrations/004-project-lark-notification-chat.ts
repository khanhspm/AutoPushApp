import type { Migration } from './types';

export const projectLarkNotificationChatMigration: Migration = {
  version: 4,
  name: 'project_lark_notification_chat',
  up(database) {
    database.exec(`
      ALTER TABLE projects ADD COLUMN lark_notification_chat_id TEXT;
    `);
  },
};
