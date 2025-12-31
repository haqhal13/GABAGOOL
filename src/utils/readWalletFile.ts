import * as fs from 'fs';
import * as path from 'path';

/**
 * Read wallet address(es) from wallet file (if it exists)
 * This makes it super easy to change the wallet - just edit the wallet file!
 * Supports:
 * - Single address: 0xABC...
 * - Multiple addresses (comma-separated): 0xABC..., 0xDEF...
 * - Comments (lines starting with #)
 * 
 * @returns Wallet address(es) as string, or null if file doesn't exist or can't be read
 */
export const readWalletFile = (): string | null => {
    try {
        const walletFilePath = path.join(process.cwd(), 'wallet');
        if (fs.existsSync(walletFilePath)) {
            const content = fs.readFileSync(walletFilePath, 'utf-8').trim();
            // Get first non-empty line (supports comments with #)
            const lines = content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
            if (lines.length > 0) {
                const walletAddresses = lines[0];
                // Count addresses (comma-separated)
                const addressCount = walletAddresses.split(',').filter(addr => addr.trim()).length;
                if (addressCount > 1) {
                    console.log(`📝 Read ${addressCount} wallet addresses from wallet file`);
                } else {
                    console.log(`📝 Read wallet address from wallet file: ${walletAddresses}`);
                }
                return walletAddresses;
            }
        }
    } catch (error) {
        // Silently fail - we'll fall back to env var or default
        console.warn('⚠️  Could not read wallet file, using environment variable or default');
    }
    return null;
};
