import crypto from 'crypto';
import { IRNGService } from '../../domain/services/IRNGService';

export class CryptoRNGService implements IRNGService {
  public generateRandomNumber(min: number, max: number): number {
    // randomInt genera un número entre min (inclusivo) y max (exclusivo)
    // Por lo tanto sumamos 1 a max para hacerlo inclusivo según la firma de nuestra interfaz
    return crypto.randomInt(min, max + 1);
  }
}
