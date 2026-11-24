import app from '../src/server/app';
import { createVercelApiHandler } from '../src/server/vercelRouting';

export default createVercelApiHandler(app);
