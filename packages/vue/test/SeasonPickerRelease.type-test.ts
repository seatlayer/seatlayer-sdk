/**
 * Compile-time contract: the Season component's exposed release() keeps Promise<void>;
 * tryRelease() is new and optional in the type, so an object a user typed as
 * the handle before it existed still compiles.
 */
import type { SeasonPickerExposed as SeasonPickerHandle } from '../src/index';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;

export type SeasonPickerReleaseContract = [
  Assert<Equal<ReturnType<SeasonPickerHandle['release']>, Promise<void>>>,
  Assert<Equal<SeasonPickerHandle['tryRelease'], ((releaseActionId: string) => Promise<boolean>) | undefined>>,
  // Every object that satisfied the handle before tryRelease still does.
  Assert<Omit<SeasonPickerHandle, 'tryRelease'> extends SeasonPickerHandle ? true : false>,
];

declare const handle: SeasonPickerHandle;
export const released: Promise<void> = handle.release('sra_type_test');
export const userMock: Pick<SeasonPickerHandle, 'release'> = { release: async () => {} };
