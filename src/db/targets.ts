import type Database from 'better-sqlite3';
import { logger } from '../logger';

export interface BudgetTarget {
  categoryId: string;
  categoryName: string;
  targetAmount: number;
  updatedAt: number;
}

export interface UnderfundedCategory {
  categoryId: string;
  categoryName: string;
  target: number;
  budgeted: number;
  gap: number;
}

interface CategoryWithIncome {
  id: string;
  name: string;
  budgeted: number;
  isIncome: boolean;
}

export function seedTargets(
  db: Database.Database,
  categories: CategoryWithIncome[]
): number {
  const now = Math.floor(Date.now() / 1000);
  const upsert = db.prepare(`
    INSERT INTO budget_targets (category_id, category_name, target_amount, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(category_id) DO UPDATE SET
      category_name = excluded.category_name,
      target_amount = excluded.target_amount,
      updated_at = excluded.updated_at
  `);

  let count = 0;
  const run = db.transaction(() => {
    for (const cat of categories) {
      if (cat.isIncome || cat.budgeted <= 0) continue;
      upsert.run(cat.id, cat.name, cat.budgeted, now);
      count++;
    }
  });
  run();
  return count;
}

export function getTargets(db: Database.Database): BudgetTarget[] {
  return (
    db.prepare('SELECT * FROM budget_targets WHERE target_amount > 0').all() as Array<{
      category_id: string; category_name: string; target_amount: number; updated_at: number;
    }>
  ).map((r) => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
    targetAmount: r.target_amount,
    updatedAt: r.updated_at,
  }));
}

export function setTarget(
  db: Database.Database,
  categoryId: string,
  categoryName: string,
  amount: number
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO budget_targets (category_id, category_name, target_amount, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(category_id) DO UPDATE SET
      category_name = excluded.category_name,
      target_amount = excluded.target_amount,
      updated_at = excluded.updated_at
  `).run(categoryId, categoryName, amount, now);
}

export function getUnderfundedCategories(
  db: Database.Database,
  liveCategories: CategoryWithIncome[]
): UnderfundedCategory[] {
  const targets = getTargets(db);
  const result: UnderfundedCategory[] = [];

  for (const target of targets) {
    const live = liveCategories.find((c) => c.id === target.categoryId);
    if (!live) {
      logger.warn('Orphaned budget target — no matching category in Actual', { categoryId: target.categoryId });
      continue;
    }
    const gap = target.targetAmount - live.budgeted;
    if (gap > 0) {
      result.push({
        categoryId: target.categoryId,
        categoryName: live.name,
        target: target.targetAmount,
        budgeted: live.budgeted,
        gap,
      });
    }
  }

  return result.sort((a, b) => b.gap - a.gap);
}

export interface TargetExport {
  exportedAt: string;
  targets: Array<{
    categoryId: string;
    categoryName: string;
    targetAmount: number;
  }>;
}

export function exportTargets(db: Database.Database): TargetExport {
  const targets = getTargets(db);
  return {
    exportedAt: new Date().toISOString(),
    targets: targets.map((t) => ({
      categoryId: t.categoryId,
      categoryName: t.categoryName,
      targetAmount: t.targetAmount,
    })),
  };
}

export function importTargets(db: Database.Database, data: TargetExport): number {
  const now = Math.floor(Date.now() / 1000);
  const upsert = db.prepare(`
    INSERT INTO budget_targets (category_id, category_name, target_amount, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(category_id) DO UPDATE SET
      category_name = excluded.category_name,
      target_amount = excluded.target_amount,
      updated_at = excluded.updated_at
  `);

  let count = 0;
  const run = db.transaction(() => {
    for (const t of data.targets) {
      if (t.targetAmount <= 0) continue;
      upsert.run(t.categoryId, t.categoryName, t.targetAmount, now);
      count++;
    }
  });
  run();
  return count;
}
