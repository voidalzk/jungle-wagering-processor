import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // Ponto de integração OIDC: conferir token e vincular o claim ao providerId.
    return true;
  }
}
