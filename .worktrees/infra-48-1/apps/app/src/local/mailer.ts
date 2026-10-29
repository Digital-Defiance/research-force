import { Mailer } from '../do/mailer';
import type { EmailProvider } from '../mail/provider';
import { localServicesFor } from './services';

export class LocalMailer extends Mailer {
  protected override emailProvider(): EmailProvider {
    const service = localServicesFor(this.env);
    return { send: (message) => service.captureMail(message) };
  }
}
