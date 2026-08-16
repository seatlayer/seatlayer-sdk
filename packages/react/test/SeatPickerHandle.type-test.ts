import type {
  PickerMapTheme,
  RendererViewMode,
  SeatPickerBestAvailableOptions,
  SeatPickerBuyerView,
  SeatPickerBuyerViewOptions,
  SeatPickerHandle,
  SeatPickerPricing,
} from '../src/index';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;

/** Compile-time contract: public barrel types and the imperative handle stay aligned. */
export type SeatPickerHandleTypeContract = [
  Assert<Equal<ReturnType<SeatPickerHandle['close']>, void>>,
  Assert<
    Equal<
      Parameters<SeatPickerHandle['bestAvailable']>[2],
      SeatPickerBestAvailableOptions | undefined
    >
  >,
  Assert<Equal<Parameters<SeatPickerHandle['setMapTheme']>[0], PickerMapTheme | null>>,
  Assert<
    Equal<Parameters<SeatPickerHandle['setPricing']>[0], SeatPickerPricing | undefined>
  >,
  Assert<Equal<ReturnType<SeatPickerHandle['isColorblindSafe']>, boolean>>,
  Assert<Equal<Parameters<SeatPickerHandle['setViewMode']>[0], RendererViewMode>>,
  Assert<Equal<ReturnType<SeatPickerHandle['getViewMode']>, RendererViewMode>>,
  Assert<Equal<ReturnType<SeatPickerHandle['getBuyerView']>, SeatPickerBuyerView>>,
  Assert<
    Equal<
      Parameters<SeatPickerHandle['setBuyerView']>,
      [view: SeatPickerBuyerView, options?: SeatPickerBuyerViewOptions]
    >
  >,
  Assert<Equal<'destroy' extends keyof SeatPickerHandle ? true : false, false>>,
];
