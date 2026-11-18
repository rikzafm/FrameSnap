/**
 * MAIN-world entry for MSE capture. Registered at document_start only for
 * sites the user granted (see platform/mse-scripts). Records from the first
 * append; the content script's handshake later turns on delivery.
 */
import { installMseHook } from "./mse-hook";
import { createMsePort, type MsePort } from "./mse-protocol";

let port: MsePort | undefined;
const store = installMseHook(window as never, { onChange: (info) => port?.notify(info) });
port = createMsePort(window, store);
