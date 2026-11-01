import { Hono } from 'hono';
import { authorizeRead } from '../../auth/authorize';
import { addFiles, attachmentResponse, editAttachment, listAttachments } from '../../files/attachments';
import { fileLink } from '../../files/links';
import { moveAttachment, previewAttachmentMove } from '../../files/move';
import type { ApiEnv } from '../app';
import { readJson } from '../input';
export const fileRoutes = new Hono<ApiEnv>();
fileRoutes.post('/attachments', async (c) => c.json({ ids: await addFiles(c, await readJson(c)) }, 201));
fileRoutes.get('/items/:id/attachments', async (c) => { await authorizeRead(c); return c.json({ attachments: await listAttachments(c, c.req.param('id')) }); });
fileRoutes.get('/attachments/:id', async (c) => { await authorizeRead(c); return c.json(await attachmentResponse(c, c.req.param('id'))); });
fileRoutes.patch('/attachments/:id', async (c) => { await editAttachment(c, c.req.param('id'), await readJson(c)); return c.json(await attachmentResponse(c, c.req.param('id'))); });
/** The Public_View diff moving this Attachment's Version_Chain to another Parent would cause, with a token when it widens a view (R12.14). */
fileRoutes.post('/attachments/:id/move/preview', async (c) => c.json(await previewAttachmentMove(c, c.req.param('id'), await readJson(c))));
/** Move this Attachment's whole Version_Chain and everything under it to another Parent; a move widening a Public_View needs the preview's token (R12.12, R12.14). */
fileRoutes.post('/attachments/:id/move', async (c) => { const move = await moveAttachment(c, c.req.param('id'), await readJson(c)); return c.json({ move, attachment: (await attachmentResponse(c, c.req.param('id'))).attachment }); });
fileRoutes.post('/files/:id/link', async (c) => { await authorizeRead(c); return c.json(await fileLink(c, c.req.param('id'))); });
