import { actualApi } from './client';
import { resolveCategory } from './naming';

export const BUDGET_MODES = ['copy_last_month', 'three_month_average', 'custom_amount'] as const;
export type BudgetMode = (typeof BUDGET_MODES)[number];

export interface SetBudgetsArgs {
  month?: string;
  mode: BudgetMode;
  category?: string;
  amount?: number;
  includeIncome?: boolean;
  dryRun?: boolean;
}

export interface BudgetChange {
  id: string;
  name: string;
  isIncome: boolean;
  oldBudgeted: number;
  newBudgeted: number;
}

export interface SetBudgetsResult {
  dryRun: boolean;
  month: string;
  mode: BudgetMode;
  includeIncome: boolean;
  categoryCount: number;
  categories: BudgetChange[];
}

interface CategoryGroupShape {
  id?: string;
  name?: string;
  hidden?: boolean;
  is_income?: boolean;
  categories?: Array<{
    id: string;
    name?: string;
    hidden?: boolean;
    is_income?: boolean;
  }>;
}

interface BudgetMonthShape {
  categoryGroups: Array<{
    is_income?: boolean;
    categories?: Array<{ id: string; name?: string; budgeted?: number }>;
  }>;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [year, monthNum] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, monthNum - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function validateMonth(month: string): void {
  if (!MONTH_RE.test(month)) {
    throw new Error(`Invalid month "${month}" — expected YYYY-MM`);
  }
}

async function readBudgetedMap(month: string): Promise<Map<string, number>> {
  const data = (await actualApi.getBudgetMonth(month)) as unknown as BudgetMonthShape;
  const budgets = new Map<string, number>();
  for (const group of data.categoryGroups ?? []) {
    for (const category of group.categories ?? []) {
      budgets.set(String(category.id), Number(category.budgeted ?? 0));
    }
  }
  return budgets;
}

export async function setBudgetsByMode(args: SetBudgetsArgs): Promise<SetBudgetsResult> {
  const month = args.month ?? currentMonth();
  validateMonth(month);

  const dryRun = args.dryRun ?? true;
  const includeIncome = args.includeIncome ?? false;
  const mode = args.mode;

  if (mode === 'custom_amount') {
    if (args.amount === undefined || !Number.isInteger(args.amount)) {
      throw new Error('amount is required as an integer number of cents for mode "custom_amount"');
    }
  }

  // Build the authoritative visibility/income metadata. This mirrors
  // getBudgetStatus(): getBudgetMonth() returns hidden categories too, so
  // getCategoryGroups() decides which ones are actually visible.
  const groups = (await actualApi.getCategoryGroups()) as unknown as CategoryGroupShape[];
  const metadata = new Map<string, { name: string; isIncome: boolean; visible: boolean }>();
  const visibleOrder: string[] = [];

  for (const group of groups) {
    const groupHidden = group.hidden === true;
    const groupIsIncome = group.is_income === true;
    for (const category of group.categories ?? []) {
      const id = String(category.id);
      const isIncome = groupIsIncome || category.is_income === true;
      const visible = !groupHidden && category.hidden !== true;
      metadata.set(id, { name: category.name ?? id, isIncome, visible });
      if (visible) visibleOrder.push(id);
    }
  }

  let selected: Array<{ id: string; name: string; isIncome: boolean }>;

  if (args.category !== undefined) {
    // A specific category overrides includeIncome: income categories are
    // allowed here, and hidden categories are resolvable by name/id too.
    const resolved = await resolveCategory(args.category);
    const meta = metadata.get(resolved.id);
    selected = [{
      id: resolved.id,
      name: resolved.name,
      isIncome: meta?.isIncome ?? false,
    }];
  } else {
    selected = visibleOrder
      .map((id) => {
        const meta = metadata.get(id)!;
        return { id, name: meta.name, isIncome: meta.isIncome };
      })
      .filter((category) => includeIncome || !category.isIncome);
  }

  const oldBudgets = await readBudgetedMap(month);

  let sourceBudgets: Map<string, number>[] = [];
  if (mode === 'copy_last_month') {
    sourceBudgets = [await readBudgetedMap(shiftMonth(month, -1))];
  } else if (mode === 'three_month_average') {
    for (let i = 3; i >= 1; i--) {
      sourceBudgets.push(await readBudgetedMap(shiftMonth(month, -i)));
    }
  }

  const categories: BudgetChange[] = selected.map((category) => {
    const oldBudgeted = oldBudgets.get(category.id) ?? 0;

    let newBudgeted: number;
    if (mode === 'custom_amount') {
      newBudgeted = args.amount as number;
    } else if (mode === 'copy_last_month') {
      newBudgeted = sourceBudgets[0]?.get(category.id) ?? 0;
    } else {
      const sum = sourceBudgets.reduce(
        (total, budgets) => total + (budgets.get(category.id) ?? 0),
        0
      );
      newBudgeted = Math.round(sum / 3);
    }

    return {
      id: category.id,
      name: category.name,
      isIncome: category.isIncome,
      oldBudgeted,
      newBudgeted,
    };
  });

  if (!dryRun) {
    await actualApi.batchBudgetUpdates(async () => {
      for (const category of categories) {
        await actualApi.setBudgetAmount(month, category.id, category.newBudgeted);
      }
    });
  }

  return {
    dryRun,
    month,
    mode,
    includeIncome,
    categoryCount: categories.length,
    categories,
  };
}
