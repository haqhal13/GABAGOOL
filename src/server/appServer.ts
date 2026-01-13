import cors from 'cors';
import express from 'express';
import Logger from '../utils/logger';
import { getSnapshot } from '../services/appState';

export interface AppServerHandle {
    port: number;
    stop: () => Promise<void>;
}

export const startAppServer = async (): Promise<AppServerHandle> => {
    const app = express();
    app.use(cors());
    app.use(express.json());

    app.get('/', (_req, res) => {
        res.json({
            message: 'EdgeBot API is running',
            endpoints: ['/health', '/state'],
        });
    });

    app.get('/health', (_req, res) => {
        const snapshot = getSnapshot();
        res.json({
            ok: snapshot.running,
            status: snapshot.status,
            updatedAt: snapshot.updatedAt,
        });
    });

    app.get('/state', (_req, res) => {
        res.json(getSnapshot());
    });

    const port = parseInt(process.env.PORT || '3000', 10);

    return await new Promise<AppServerHandle>((resolve) => {
        const server = app.listen(port, () => {
            Logger.success(`Web API listening on port ${port}`);
            resolve({
                port,
                stop: () =>
                    new Promise<void>((resolveClose, rejectClose) => {
                        server.close((error) => {
                            if (error) {
                                rejectClose(error);
                            } else {
                                resolveClose();
                            }
                        });
                    }),
            });
        });
    });
};

export default startAppServer;
