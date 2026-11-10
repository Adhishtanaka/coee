#import "Session.h"

@implementation Session
- (void)saveLogin:(NSString *)token {
    [[NSUserDefaults standardUserDefaults] setObject:token forKey:@"authToken"];
}
- (void)restore:(NSData *)data {
    id saved = [NSKeyedUnarchiver unarchiveObjectWithData:data];
    NSDictionary *query = @{ (id)kSecAttrAccessible: (id)kSecAttrAccessibleAlways };
}
- (void)copyName:(const char *)name {
    char buf[16];
    strcpy(buf, name);
}
@end
