import * as readline from 'readline';
import watchlistManager from './watchlistManager';
import Logger from '../utils/logger';

/**
 * Command Handler - Handles interactive commands while the bot is running
 * Allows users to manage watchlist, view status, etc.
 */

class CommandHandler {
    private rl: readline.Interface | null = null;
    private isRunning = false;

    /**
     * Start listening for commands
     */
    start(): void {
        if (this.isRunning) return;

        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        this.isRunning = true;

        // Don't show prompt - just listen for input
        this.rl.on('line', (input) => {
            this.handleCommand(input.trim());
        });

        this.rl.on('close', () => {
            this.isRunning = false;
        });

        Logger.info('Command handler started. Type /help for available commands.');
    }

    /**
     * Stop listening for commands
     */
    stop(): void {
        if (this.rl) {
            this.rl.close();
            this.rl = null;
        }
        this.isRunning = false;
    }

    /**
     * Handle a command
     */
    private handleCommand(input: string): void {
        if (!input.startsWith('/')) {
            return; // Ignore non-commands
        }

        const parts = input.slice(1).split(/\s+/);
        const command = parts[0]?.toLowerCase();
        const args = parts.slice(1);

        switch (command) {
            case 'help':
            case 'h':
                this.showHelp();
                break;

            case 'list':
            case 'l':
            case 'watchlist':
                watchlistManager.displayWatchlist();
                break;

            case 'add':
            case 'a':
            case 'watch':
                this.handleAdd(args);
                break;

            case 'remove':
            case 'rm':
            case 'delete':
            case 'unwatch':
                this.handleRemove(args);
                break;

            case 'toggle':
            case 't':
                this.handleToggle(args);
                break;

            case 'enable':
                this.handleEnable(args);
                break;

            case 'disable':
                this.handleDisable(args);
                break;

            case 'alias':
            case 'name':
                this.handleAlias(args);
                break;

            case 'status':
            case 's':
                this.showStatus();
                break;

            case 'clear':
                console.clear();
                break;

            default:
                Logger.warning(`Unknown command: /${command}. Type /help for available commands.`);
        }
    }

    /**
     * Show help message
     */
    private showHelp(): void {
        console.log('\n╔══════════════════════════════════════════════════════════════╗');
        console.log('║                    📖 COMMANDS                               ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║  WATCHLIST MANAGEMENT:                                       ║');
        console.log('║    /add <address> [alias]    Add a new address to watch      ║');
        console.log('║    /remove <address|alias>   Remove address from watchlist   ║');
        console.log('║    /toggle <address|alias>   Toggle address on/off           ║');
        console.log('║    /enable <address|alias>   Enable address monitoring       ║');
        console.log('║    /disable <address|alias>  Disable address monitoring      ║');
        console.log('║    /alias <address> <name>   Set alias for an address        ║');
        console.log('║    /list                     Show all watched addresses      ║');
        console.log('║                                                              ║');
        console.log('║  GENERAL:                                                    ║');
        console.log('║    /status                   Show bot status                 ║');
        console.log('║    /clear                    Clear the console               ║');
        console.log('║    /help                     Show this help message          ║');
        console.log('║                                                              ║');
        console.log('║  SHORTCUTS: /a=add, /rm=remove, /t=toggle, /l=list, /s=status║');
        console.log('╚══════════════════════════════════════════════════════════════╝\n');
    }

    /**
     * Handle add command
     */
    private handleAdd(args: string[]): void {
        if (args.length < 1) {
            Logger.warning('Usage: /add <address> [alias]');
            Logger.info('Example: /add 0x1234...abcd trader1');
            return;
        }

        const address = args[0];
        const alias = args.slice(1).join(' ') || undefined;

        watchlistManager.addAddress(address, alias);
    }

    /**
     * Handle remove command
     */
    private handleRemove(args: string[]): void {
        if (args.length < 1) {
            Logger.warning('Usage: /remove <address|alias>');
            return;
        }

        const addressOrAlias = args.join(' ');
        watchlistManager.removeAddress(addressOrAlias);
    }

    /**
     * Handle toggle command
     */
    private handleToggle(args: string[]): void {
        if (args.length < 1) {
            Logger.warning('Usage: /toggle <address|alias>');
            return;
        }

        const addressOrAlias = args.join(' ');
        watchlistManager.toggleAddress(addressOrAlias);
    }

    /**
     * Handle enable command
     */
    private handleEnable(args: string[]): void {
        if (args.length < 1) {
            Logger.warning('Usage: /enable <address|alias>');
            return;
        }

        const addressOrAlias = args.join(' ');
        watchlistManager.toggleAddress(addressOrAlias, true);
    }

    /**
     * Handle disable command
     */
    private handleDisable(args: string[]): void {
        if (args.length < 1) {
            Logger.warning('Usage: /disable <address|alias>');
            return;
        }

        const addressOrAlias = args.join(' ');
        watchlistManager.toggleAddress(addressOrAlias, false);
    }

    /**
     * Handle alias command
     */
    private handleAlias(args: string[]): void {
        if (args.length < 2) {
            Logger.warning('Usage: /alias <address> <name>');
            Logger.info('Example: /alias 0x1234...abcd "Top Trader"');
            return;
        }

        const address = args[0];
        const alias = args.slice(1).join(' ');
        watchlistManager.setAlias(address, alias);
    }

    /**
     * Show bot status
     */
    private showStatus(): void {
        const counts = watchlistManager.getCount();
        const addresses = watchlistManager.getAllAddresses();

        console.log('\n╔══════════════════════════════════════════════════════════════╗');
        console.log('║                    📊 BOT STATUS                             ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log(`║  Watched Addresses: ${counts.active} active / ${counts.total} total`.padEnd(63) + '║');
        console.log('║                                                              ║');

        if (addresses.length > 0) {
            console.log('║  Addresses:                                                  ║');
            for (const entry of addresses) {
                const status = entry.enabled ? '🟢' : '🔴';
                const name = entry.alias || `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`;
                console.log(`║    ${status} ${name}`.padEnd(63) + '║');
            }
        }

        console.log('╚══════════════════════════════════════════════════════════════╝\n');
    }
}

// Export singleton instance
const commandHandler = new CommandHandler();
export default commandHandler;
