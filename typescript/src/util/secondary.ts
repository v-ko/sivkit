import { createId } from "./base";
import { getLogger } from "../logging";

let log = getLogger('util');

const MAX_CHECKS = 100;
/**
 * Generates a unique path by appending integer suffixes or a random ID if needed
 * @param basePath The original path to make unique
 * @param pathExistsChecker Function that returns true if a path already exists
 * @returns A unique path
 */
export function generateUniquePathWithSuffix(basePath: string, pathExistsChecker: (path: string) => boolean, max_checks: number = MAX_CHECKS): string {
    let path = basePath;
    let counter = 1;

    // Check if a path already exists
    while (pathExistsChecker(path)) {
        if (counter > max_checks) {
            log.warning(`Exceeded MAX_CHECKS (${max_checks}) for path uniqueness, using random ID for path: ${basePath}`);

            // Extract name and extension from path
            const lastDotIndex = basePath.lastIndexOf('.');
            const name = lastDotIndex !== -1 ? basePath.substring(0, lastDotIndex) : basePath;
            const extension = lastDotIndex !== -1 ? basePath.substring(lastDotIndex) : '';

            const randomId = createId();
            path = `${name}_${randomId}${extension}`;

            if (counter > max_checks + 1) {
                log.error(`Unable to generate a unique path after ${max_checks} checks, using random ID: ${path}`);
            }
        }

        // Extract name and extension from path
        const lastDotIndex = basePath.lastIndexOf('.');
        const name = lastDotIndex !== -1 ? basePath.substring(0, lastDotIndex) : basePath;
        const extension = lastDotIndex !== -1 ? basePath.substring(lastDotIndex) : '';

        // Add counter to path
        path = `${name}_${counter}${extension}`;
        counter++;
    }

    return path;
}
