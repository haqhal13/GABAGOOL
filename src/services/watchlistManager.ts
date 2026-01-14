import * as fs from 'fs';
import * as path from 'path';
import Logger from '../utils/logger';

/**
 * Watchlist Manager - Manages watched addresses dynamically
 * Allows adding/removing addresses at runtime without restarting the bot
 * Supports external updates from webapp via file watching or direct API calls
 */

interface WatchedAddress {
    address: string;
    alias?: string;  // Optional friendly name
    addedAt: number; // Timestamp when added
    enabled: boolean; // Whether to actively monitor
}

interface WatchlistData {
    version: number;
    addresses: WatchedAddress[];
    lastModified: number;
}

class WatchlistManager {
    private watchlist: Map<string, WatchedAddress> = new Map();
    private watchlistPath: string;
    private onChangeCallbacks: Array<(addresses: string[]) => void> = [];
    private fileWatcher: fs.FSWatcher | null = null;
    private pollInterval: NodeJS.Timeout | null = null;
    private lastFileModified: number = 0;

    constructor() {
        this.watchlistPath = path.join(process.cwd(), 'watchlist.json');
        this.loadWatchlist();
        this.startFileWatcher();
        this.startPolling(); // Poll for changes in case file watcher misses updates
    }

    /**
     * Load watchlist from file or initialize from wallet file/env
     */
    private loadWatchlist(): void {
        try {
            // First check if watchlist.json exists
            if (fs.existsSync(this.watchlistPath)) {
                const content = fs.readFileSync(this.watchlistPath, 'utf-8');
                const data: WatchlistData = JSON.parse(content);

                this.watchlist.clear();
                for (const entry of data.addresses) {
                    const normalized = entry.address.toLowerCase();
                    this.watchlist.set(normalized, {
                        ...entry,
                        address: normalized,
                    });
                }
                Logger.info(`Loaded ${this.watchlist.size} address(es) from watchlist.json`);
                return;
            }

            // If no watchlist.json, try to read from wallet file
            const walletPath = path.join(process.cwd(), 'wallet');
            if (fs.existsSync(walletPath)) {
                const content = fs.readFileSync(walletPath, 'utf-8').trim();
                const lines = content.split('\n')
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#'));

                if (lines.length > 0) {
                    const addresses = lines[0].split(',').map(addr => addr.trim().toLowerCase());
                    for (const addr of addresses) {
                        if (this.isValidAddress(addr)) {
                            this.watchlist.set(addr, {
                                address: addr,
                                addedAt: Date.now(),
                                enabled: true,
                            });
                        }
                    }
                    Logger.info(`Loaded ${this.watchlist.size} address(es) from wallet file`);
                    // Save to watchlist.json for future use
                    this.saveWatchlist();
                }
            }

            // If still empty, check ENV
            if (this.watchlist.size === 0 && process.env.USER_ADDRESSES) {
                const envAddresses = process.env.USER_ADDRESSES.split(',')
                    .map(addr => addr.trim().toLowerCase());
                for (const addr of envAddresses) {
                    if (this.isValidAddress(addr)) {
                        this.watchlist.set(addr, {
                            address: addr,
                            addedAt: Date.now(),
                            enabled: true,
                        });
                    }
                }
                Logger.info(`Loaded ${this.watchlist.size} address(es) from USER_ADDRESSES`);
                this.saveWatchlist();
            }
        } catch (error) {
            Logger.error(`Failed to load watchlist: ${error}`);
        }
    }

    /**
     * Save watchlist to file
     */
    private saveWatchlist(): void {
        try {
            const data: WatchlistData = {
                version: 1,
                addresses: Array.from(this.watchlist.values()),
                lastModified: Date.now(),
            };
            fs.writeFileSync(this.watchlistPath, JSON.stringify(data, null, 2));
        } catch (error) {
            Logger.error(`Failed to save watchlist: ${error}`);
        }
    }

    /**
     * Watch the watchlist file for external changes
     */
    private startFileWatcher(): void {
        try {
            // Watch the directory instead - more reliable for file replacements
            const dir = path.dirname(this.watchlistPath);
            const filename = path.basename(this.watchlistPath);

            this.fileWatcher = fs.watch(dir, (eventType, changedFile) => {
                if (changedFile === filename) {
                    // Debounce rapid changes
                    setTimeout(() => {
                        this.checkForUpdates();
                    }, 100);
                }
            });
        } catch (error) {
            Logger.warning(`Could not start file watcher: ${error}`);
        }
    }

    /**
     * Poll for file changes (backup for file watcher)
     */
    private startPolling(): void {
        // Check every 2 seconds for external changes
        this.pollInterval = setInterval(() => {
            this.checkForUpdates();
        }, 2000);
    }

    /**
     * Check if the watchlist file has been modified externally
     */
    private checkForUpdates(): void {
        try {
            if (!fs.existsSync(this.watchlistPath)) {
                return;
            }

            const stats = fs.statSync(this.watchlistPath);
            const modifiedTime = stats.mtimeMs;

            if (modifiedTime > this.lastFileModified) {
                this.lastFileModified = modifiedTime;
                Logger.info('Watchlist file changed externally, reloading...');
                this.reloadFromFile();
            }
        } catch {
            // Ignore stat errors
        }
    }

    /**
     * Reload watchlist from file (called on external change)
     */
    private reloadFromFile(): void {
        try {
            if (!fs.existsSync(this.watchlistPath)) {
                return;
            }

            const content = fs.readFileSync(this.watchlistPath, 'utf-8');
            const data: WatchlistData = JSON.parse(content);

            const oldAddresses = new Set(this.watchlist.keys());
            const newAddresses = new Set<string>();

            this.watchlist.clear();
            for (const entry of data.addresses) {
                const normalized = entry.address.toLowerCase();
                newAddresses.add(normalized);
                this.watchlist.set(normalized, {
                    ...entry,
                    address: normalized,
                });
            }

            // Check if there were actual changes
            const added = [...newAddresses].filter(a => !oldAddresses.has(a));
            const removed = [...oldAddresses].filter(a => !newAddresses.has(a));

            if (added.length > 0 || removed.length > 0) {
                if (added.length > 0) {
                    Logger.success(`Added ${added.length} new address(es) to watchlist`);
                }
                if (removed.length > 0) {
                    Logger.info(`Removed ${removed.length} address(es) from watchlist`);
                }
                this.notifyChange();
            }
        } catch (error) {
            Logger.error(`Failed to reload watchlist: ${error}`);
        }
    }

    /**
     * Validate Ethereum address format
     */
    private isValidAddress(address: string): boolean {
        return /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    /**
     * Add a new address to watch
     */
    addAddress(address: string, alias?: string): boolean {
        const normalized = address.toLowerCase();

        if (!this.isValidAddress(normalized)) {
            Logger.error(`Invalid address format: ${address}`);
            return false;
        }

        if (this.watchlist.has(normalized)) {
            Logger.warning(`Address already in watchlist: ${normalized}`);
            return false;
        }

        this.watchlist.set(normalized, {
            address: normalized,
            alias,
            addedAt: Date.now(),
            enabled: true,
        });

        this.saveWatchlist();
        this.notifyChange();

        Logger.success(`Added address to watchlist: ${alias || normalized.slice(0, 10)}...`);
        return true;
    }

    /**
     * Remove an address from watch
     */
    removeAddress(addressOrAlias: string): boolean {
        const normalized = addressOrAlias.toLowerCase();

        // Try to find by address first
        if (this.watchlist.has(normalized)) {
            this.watchlist.delete(normalized);
            this.saveWatchlist();
            this.notifyChange();
            Logger.success(`Removed address from watchlist: ${normalized.slice(0, 10)}...`);
            return true;
        }

        // Try to find by alias
        for (const [addr, entry] of this.watchlist.entries()) {
            if (entry.alias?.toLowerCase() === normalized) {
                this.watchlist.delete(addr);
                this.saveWatchlist();
                this.notifyChange();
                Logger.success(`Removed address from watchlist: ${entry.alias}`);
                return true;
            }
        }

        Logger.warning(`Address not found in watchlist: ${addressOrAlias}`);
        return false;
    }

    /**
     * Enable/disable an address
     */
    toggleAddress(addressOrAlias: string, enabled?: boolean): boolean {
        const normalized = addressOrAlias.toLowerCase();

        // Try to find by address
        if (this.watchlist.has(normalized)) {
            const entry = this.watchlist.get(normalized)!;
            entry.enabled = enabled !== undefined ? enabled : !entry.enabled;
            this.saveWatchlist();
            this.notifyChange();
            Logger.info(`Address ${entry.enabled ? 'enabled' : 'disabled'}: ${entry.alias || normalized.slice(0, 10)}...`);
            return true;
        }

        // Try to find by alias
        for (const entry of this.watchlist.values()) {
            if (entry.alias?.toLowerCase() === normalized) {
                entry.enabled = enabled !== undefined ? enabled : !entry.enabled;
                this.saveWatchlist();
                this.notifyChange();
                Logger.info(`Address ${entry.enabled ? 'enabled' : 'disabled'}: ${entry.alias}`);
                return true;
            }
        }

        Logger.warning(`Address not found: ${addressOrAlias}`);
        return false;
    }

    /**
     * Set alias for an address
     */
    setAlias(address: string, alias: string): boolean {
        const normalized = address.toLowerCase();

        if (!this.watchlist.has(normalized)) {
            Logger.warning(`Address not found: ${address}`);
            return false;
        }

        const entry = this.watchlist.get(normalized)!;
        entry.alias = alias;
        this.saveWatchlist();

        Logger.success(`Set alias for ${normalized.slice(0, 10)}...: ${alias}`);
        return true;
    }

    /**
     * Get all watched addresses (only enabled ones)
     */
    getActiveAddresses(): string[] {
        return Array.from(this.watchlist.values())
            .filter(entry => entry.enabled)
            .map(entry => entry.address);
    }

    /**
     * Get all watched addresses (including disabled)
     */
    getAllAddresses(): WatchedAddress[] {
        return Array.from(this.watchlist.values());
    }

    /**
     * Get a specific address entry
     */
    getAddress(addressOrAlias: string): WatchedAddress | undefined {
        const normalized = addressOrAlias.toLowerCase();

        if (this.watchlist.has(normalized)) {
            return this.watchlist.get(normalized);
        }

        // Try by alias
        for (const entry of this.watchlist.values()) {
            if (entry.alias?.toLowerCase() === normalized) {
                return entry;
            }
        }

        return undefined;
    }

    /**
     * Get count of watched addresses
     */
    getCount(): { total: number; active: number } {
        const all = Array.from(this.watchlist.values());
        return {
            total: all.length,
            active: all.filter(e => e.enabled).length,
        };
    }

    /**
     * Register a callback for when watchlist changes
     */
    onChange(callback: (addresses: string[]) => void): void {
        this.onChangeCallbacks.push(callback);
    }

    /**
     * Notify all listeners of watchlist change
     */
    private notifyChange(): void {
        const addresses = this.getActiveAddresses();
        for (const callback of this.onChangeCallbacks) {
            try {
                callback(addresses);
            } catch (error) {
                Logger.error(`Error in watchlist change callback: ${error}`);
            }
        }
    }

    /**
     * Display watchlist in console
     */
    displayWatchlist(): void {
        const addresses = this.getAllAddresses();

        console.log('\n╔══════════════════════════════════════════════════════════════╗');
        console.log('║                    📋 WATCHLIST                              ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');

        if (addresses.length === 0) {
            console.log('║  No addresses in watchlist                                   ║');
        } else {
            for (let i = 0; i < addresses.length; i++) {
                const entry = addresses[i];
                const status = entry.enabled ? '✅' : '⏸️ ';
                const alias = entry.alias ? ` (${entry.alias})` : '';
                const shortAddr = `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`;
                const line = `  ${i + 1}. ${status} ${shortAddr}${alias}`;
                console.log(`║${line.padEnd(62)}║`);
            }
        }

        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║  Commands:                                                   ║');
        console.log('║    /add <address> [alias]  - Add address to watch            ║');
        console.log('║    /remove <address|alias> - Remove address from watchlist   ║');
        console.log('║    /toggle <address|alias> - Enable/disable an address       ║');
        console.log('║    /alias <address> <name> - Set alias for address           ║');
        console.log('║    /list                   - Show this watchlist             ║');
        console.log('╚══════════════════════════════════════════════════════════════╝\n');
    }

    /**
     * Get the path to the watchlist file (for external apps)
     */
    getWatchlistPath(): string {
        return this.watchlistPath;
    }

    /**
     * Force a reload from file (useful for API calls)
     */
    forceReload(): void {
        this.lastFileModified = 0; // Reset to force reload
        this.checkForUpdates();
    }

    /**
     * Get watchlist as JSON (for API responses)
     */
    toJSON(): WatchlistData {
        return {
            version: 1,
            addresses: Array.from(this.watchlist.values()),
            lastModified: Date.now(),
        };
    }

    /**
     * Stop file watcher and polling
     */
    stop(): void {
        if (this.fileWatcher) {
            this.fileWatcher.close();
            this.fileWatcher = null;
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }
}

// Export singleton instance
const watchlistManager = new WatchlistManager();
export default watchlistManager;
export { WatchedAddress, WatchlistData };
