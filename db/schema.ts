import { sqliteTable, text, integer, real, index, primaryKey } from 'drizzle-orm/sqlite-core';

export const accountHistory = sqliteTable('account_history', {
  account: text('account').primaryKey(), data: text('data').notNull(),
  revision: integer('revision').notNull().default(1), updated: text('updated').notNull(),
  tradesData: text('trades_data').notNull().default('[]'),
  summaryData: text('summary_data').notNull().default('{}'),
});
export const accountProfiles = sqliteTable('account_profiles', { account: text('account').primaryKey(), data: text('data').notNull() });
export const tradeNotes = sqliteTable('trade_notes', { id: text('id').primaryKey(), account: text('account').notNull(), data: text('data').notNull() });
export const cashRecords = sqliteTable('cash_records', { id: text('id').primaryKey(), data: text('data').notNull() });
export const journalImports = sqliteTable('journal_imports', { id: text('id').primaryKey(), source: text('source').notNull(), added: integer('added').notNull(), duplicates: integer('duplicates').notNull(), importedAt: text('imported_at').notNull() });
export const journalMeta = sqliteTable('journal_meta', { key: text('key').primaryKey(), value: text('value').notNull() });
export const recorderStatus = sqliteTable('recorder_status', { id: text('id').primaryKey(), capturedAt: text('captured_at').notNull(), data: text('data').notNull() });
export const accountStatus = sqliteTable('account_status', { account: text('account').primaryKey(), capturedAt: text('captured_at').notNull(), data: text('data').notNull() });

export const firmReferences = sqliteTable('firm_references', {account:text('account').primaryKey(),data:text('data').notNull()});
export const recorderCaptures=sqliteTable('recorder_captures',{capturedAt:text('captured_at').primaryKey(),data:text('data').notNull(),receivedAt:text('received_at').notNull()});
export const accountObservations=sqliteTable('account_observations',{id:text('id').primaryKey(),account:text('account').notNull(),capturedAt:text('captured_at').notNull(),origin:text('origin').notNull(),cashValue:real('cash_value'),data:text('data').notNull(),receivedAt:text('received_at').notNull()},table=>[index('account_observations_account_time').on(table.account,table.capturedAt)]);
export const balanceAdjustmentLabels=sqliteTable('balance_adjustment_labels',{id:text('id').primaryKey(),data:text('data').notNull()});
export const executionTimes=sqliteTable('execution_times',{account:text('account').notNull(),time:text('time').notNull()},table=>[primaryKey({columns:[table.account,table.time]})]);
