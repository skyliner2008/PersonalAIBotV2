import type { Page } from 'playwright';
/**
 * Check if currently logged in to Facebook.
 */
export declare function isLoggedIn(): Promise<boolean>;
/**
 * Login to Facebook with email and password.
 * Uses page.fill() for reliable input instead of keyboard typing.
 */
export declare function login(email?: string, password?: string): Promise<boolean>;
/**
 * Navigate to a specific Facebook page.
 */
export declare function navigateTo(url: string, page?: Page): Promise<Page>;
/**
 * Create a text post on profile/page/group.
 */
export declare function createPost(content: string, target?: 'profile' | 'page' | 'group', targetId?: string): Promise<boolean>;
/**
 * Get the Facebook user name from the logged-in session.
 */
export declare function getLoggedInUserName(): Promise<string | null>;
