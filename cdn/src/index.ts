/**
 * Browser/CDN entrypoint. The implementation is re-exported directly from the
 * same @seatlayer/js source tree that produces npm; this file only adds an
 * inspectable release version for script-tag consumers.
 */
export * from '../../packages/js/src/index';

declare const __SEATLAYER_SDK_VERSION__: string;
export const version = __SEATLAYER_SDK_VERSION__;
