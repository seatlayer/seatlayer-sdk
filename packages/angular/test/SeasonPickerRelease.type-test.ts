/**
 * Compile-time contract: the component's release() keeps Promise<void>;
 * tryRelease() is the new method that says whether the seats went. Compiled by
 * this package's typecheck (tsconfig.type-test.json).
 */
import type { SeatLayerSeasonPickerComponent } from '../src/season-picker.component';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;

export type SeasonPickerReleaseContract = [
  Assert<Equal<ReturnType<SeatLayerSeasonPickerComponent['release']>, Promise<void>>>,
  Assert<Equal<ReturnType<SeatLayerSeasonPickerComponent['tryRelease']>, Promise<boolean>>>,
];

declare const component: SeatLayerSeasonPickerComponent;
export const released: Promise<void> = component.release('sra_type_test');
export const userMock: Pick<SeatLayerSeasonPickerComponent, 'release'> = { release: async () => {} };
