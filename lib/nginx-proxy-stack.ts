import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export class NginxProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      env: {
        region: "ap-southeast-1",
      },
      ...props,
    });

    // Create VPC
    const vpc = new ec2.Vpc(this, "NginxVpc", {
      maxAzs: 2,
      natGateways: 0,
    });

    // Security group for ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      description: "Security group for ALB",
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow HTTPS traffic"
    );

    // Security group for EC2 instance
    const ec2SecurityGroup = new ec2.SecurityGroup(this, "NginxSecurityGroup", {
      vpc,
      description: "Security group for Nginx instance",
      allowAllOutbound: true,
    });

    // Allow traffic from ALB to EC2 instance
    ec2SecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
      ec2.Port.tcp(80), // Change to 80
      "Allow HTTP traffic from ALB"
    );

    // Create ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, "NginxAlb", {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });

    // Create ACM certificate
    const certificate = new acm.Certificate(this, "NginxCertificate", {
      domainName: "www.bim.com.sg",
      validation: acm.CertificateValidation.fromDns(),
    });

    // Create target group
    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "NginxTargetGroup",
      {
        vpc,
        port: 80, // Change to 80
        protocol: elbv2.ApplicationProtocol.HTTP, // Change to HTTP
        targetType: elbv2.TargetType.INSTANCE,
        healthCheck: {
          path: "/",
          healthyHttpCodes: "200-399",
        },
      }
    );

    // Create HTTPS listener with host header condition and redirect rule
    const listener = alb.addListener("HttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [{ certificateArn: certificate.certificateArn }],
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: "text/plain",
        messageBody: "Forbidden",
      }),
    });

    listener.addAction("AllowBimecoDomain", {
      action: elbv2.ListenerAction.forward([targetGroup]),
      conditions: [elbv2.ListenerCondition.hostHeaders(["www.bim.com.sg"])],
      priority: 3,
    });

    // Create user data with simplified Nginx configuration
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "sudo apt-get update -y",
      "sudo apt-get install -y nginx",

      `sudo bash -c 'cat > /etc/nginx/sites-available/default <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name _;

    location / {
        proxy_pass https://www.bim.com.sg;
        proxy_set_header Host www.bim.com.sg;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_ssl_server_name on;
    }

        # For Next.js static files in jobs section
    location /_next/ {
        proxy_pass https://jobs.bimeco.io/_next/;
        proxy_set_header Host jobs.bimeco.io;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_ssl_server_name on;
    }

    # For the jobs section
    location /jobs {
        # Rewrite /jobs to /career
        rewrite ^/jobs(/.*)?\\$ /career\\$1 break;
        proxy_pass https://jobs.bimeco.io;
        proxy_set_header Host jobs.bimeco.io;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_ssl_server_name on;

        proxy_redirect https://jobs.bimeco.io/career/ /jobs/;

        proxy_connect_timeout 60s;
        proxy_read_timeout 60s;
    }

    # error handling
    error_page 404 /404.html;
    error_page 500 502 503 504 /50x.html;
    location = /50x.html {
        root /usr/share/nginx/html;
    }
}

EOF'`,
      "sudo nginx -t",
      "sudo systemctl restart nginx",
      "sudo systemctl enable nginx"
    );

    // Create EC2 instance
    const instance = new ec2.Instance(this, "NginxInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: ec2SecurityGroup,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.MICRO
      ),
      machineImage: ec2.MachineImage.genericLinux({
        "ap-southeast-1": "ami-0672fd5b9210aa093",
      }),
      userData,
    });

    // Add EC2 instance to target group using InstanceTarget
    targetGroup.addTarget(new targets.InstanceTarget(instance));

    // Output the ALB DNS name
    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: `https://${alb.loadBalancerDnsName}`,
      description: "DNS name of the load balancer",
    });
  }
}
