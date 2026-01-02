import * as fs from 'fs';
import * as path from 'path';

class SizeScaler {
    private scales = new Map<string, number>();
    private initialized = false;

    private init(): void {
        if (this.initialized) return;
        this.initialized = true;

        try {
            const csvPath = path.join(
                process.cwd(),
                'watch_bot_analyzer',
                'output',
                'diff_summary.csv'
            );

            if (!fs.existsSync(csvPath)) {
                return;
            }

            const content = fs.readFileSync(csvPath, 'utf8');
            const lines = content
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.length > 0);

            if (lines.length < 2) {
                return;
            }

            const header = lines[0].split(',');
            const marketIndex = header.indexOf('market');
            const ratioIndex = header.indexOf('median_size_ratio');

            if (marketIndex === -1 || ratioIndex === -1) {
                return;
            }

            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',');
                if (cols.length <= Math.max(marketIndex, ratioIndex)) continue;

                const market = cols[marketIndex].trim();
                const ratioRaw = cols[ratioIndex].trim();
                const ratio = parseFloat(ratioRaw);

                if (!market || !isFinite(ratio) || ratio <= 0) continue;

                const rawScale = 1 / ratio;
                const scale = Math.max(0.2, Math.min(5, rawScale));

                this.scales.set(market, scale);
            }
        } catch {
            return;
        }
    }

    getScale(marketKey: string): number {
        this.init();
        const scale = this.scales.get(marketKey);
        if (scale !== undefined && isFinite(scale) && scale > 0) {
            return scale;
        }
        return 1;
    }
}

export const sizeScaler = new SizeScaler();

