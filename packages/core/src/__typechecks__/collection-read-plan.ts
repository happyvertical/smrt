import {
  executeCollectionReadPlan,
  type SmrtCollectionReadPlan,
  type SmrtCollectionReadPlanEntry,
  type SmrtCollectionReadPlanResult,
} from '../collection-read-plan';
import type { SmrtObject } from '../object';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type ReadPlanTypeProbe = SmrtObject & { name: string };

const plain: SmrtCollectionReadPlanEntry<ReadPlanTypeProbe> = {
  className: 'ReadPlanTypeProbe',
};
const projected: SmrtCollectionReadPlanEntry<
  ReadPlanTypeProbe,
  { select: readonly ['id', 'name'] }
> = {
  className: 'ReadPlanTypeProbe',
  options: { select: ['id', 'name'] },
};

type Result = SmrtCollectionReadPlanResult<{
  plain: typeof plain;
  projected: typeof projected;
}>;
type PlainResultIsTyped = Expect<Equal<Result['plain'], ReadPlanTypeProbe[]>>;
type ProjectedResultIsTyped = Expect<
  Equal<Result['projected'], { id: string | null | undefined; name: string }[]>
>;
type InvalidOptionsAreRejected = Expect<
  Equal<
    { limit: string } extends NonNullable<
      SmrtCollectionReadPlan[string]['options']
    >
      ? true
      : false,
    false
  >
>;

async function validateExecutorInference(): Promise<void> {
  const result = await executeCollectionReadPlan(
    { plain, projected },
    { maxConcurrency: 1 },
  );
  type ExecutorPlainResultIsTyped = Expect<
    Equal<typeof result.plain, ReadPlanTypeProbe[]>
  >;
  type ExecutorProjectedResultIsTyped = Expect<
    Equal<
      typeof result.projected,
      { id: string | null | undefined; name: string }[]
    >
  >;
  const assertions: [
    ExecutorPlainResultIsTyped,
    ExecutorProjectedResultIsTyped,
  ] = [true, true];
  void assertions;
}
void validateExecutorInference;

export type CollectionReadPlanTypeAssertions = [
  PlainResultIsTyped,
  ProjectedResultIsTyped,
  InvalidOptionsAreRejected,
];
